import { ApiRequestError } from '../../shared/api/client';
import type { ApiClient, RequestOptions } from '../../shared/api/client';
import type { EmailChangeInput, EmailChangeCancellation, EmailChangeResult } from '../../shared/api/contracts';
import type { AccessToken, LoginInput, PasswordChangeInput, ProfilePatch, SecurityChangeResult, User } from '../../shared/api/contracts';
import type { MailRequestResult, VerificationInput } from '../../shared/api/contracts';
import type { PasswordResetInput } from '../../shared/api/contracts';
import { browserCoordinator } from './coordination';
import type { SessionCoordinator, SessionEvent } from './coordination';
import { requestDeadline } from '../../shared/api/deadline';

export type SessionStatus = 'restoring' | 'anonymous' | 'authenticated' | 'refreshing' | 'signing-in' | 'profile-error' | 'unavailable' | 'logging-out' | 'logout-error';
export interface SessionSnapshot {
  status: SessionStatus;
  user: User | null;
  message: string | null;
  revision: number;
}
interface Grant { tokens: AccessToken; requestedAt: number; userId: string | null }

function stale(): ApiRequestError {
  return new ApiRequestError('cancelled', 'identity_changed', 'Your session changed. Please try again.');
}

const unavailable = 'We couldn’t check your session. Retry the session check or sign in again.';
const profileUnavailable = 'Your credentials were accepted, but your account could not be loaded. Retry loading your account.';
const logoutUnavailable = 'Sign-out could not be confirmed. Your data is hidden. Retry sign-out.';

// Only identity/state leave this controller; credentials never enter storage or
// cross-tab messages. Request generations reject work for a superseded identity.
export class SessionController {
  private snapshot: SessionSnapshot = { status: 'restoring', user: null, message: null, revision: 0 };
  private anonymousVerified = false;
  private grant: Grant | null = null;
  private listeners = new Set<() => void>();
  private guestRecoveryListeners = new Set<() => void>();
  private guestListeners = new Set<() => void>();
  private coordinator: SessionCoordinator | null = null;
  private unsubscribe: (() => void) | null = null;
  private flight: Promise<void> | null = null;
  private logoutFlight: Promise<void> | null = null;
  private controllers = new Set<AbortController>();
  private privateRequests = new AbortController();
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private peerDeadline: ReturnType<typeof setTimeout> | undefined;
  private restoreWanted = false;
  private started = false;

  constructor(readonly api: ApiClient, private factory: () => SessionCoordinator = browserCoordinator) { }
  get coordinationAvailable(): boolean { return this.coordinator !== null; }
  get canShopAsGuest(): boolean { return this.anonymousVerified && this.snapshot.status === 'anonymous'; }
  getSnapshot = (): SessionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  start(): void {
    clearTimeout(this.stopTimer);
    if (this.started) return;
    this.started = true;
    try {
      this.coordinator = this.factory();
      this.unsubscribe = this.coordinator.subscribe((event) => this.receive(event));
    } catch {
      this.invalidate('unavailable', 'Session access is unavailable in this browser. Use an updated browser and try again.');
    }
  }

  // StrictMode immediately reattaches effects. Do not abort a cookie rotation
  // during that reattachment: its transaction may already have committed.
  release(): void { this.stopTimer = setTimeout(() => this.dispose(), 0); }
  dispose(): void {
    this.started = false;
    this.restoreWanted = false;
    clearTimeout(this.stopTimer);
    clearTimeout(this.expiry);
    clearTimeout(this.peerDeadline);
    this.controllers.forEach((controller) => controller.abort());
    this.privateRequests.abort();
    this.grant = null;
    this.unsubscribe?.();
    this.coordinator?.close();
    this.coordinator = null;
  }

  private set(status: SessionStatus, user: User | null = null, message: string | null = null): void {
    this.snapshot = { status, user, message, revision: this.snapshot.revision };
    this.listeners.forEach((listener) => listener());
  }

  private invalidate(status: SessionStatus, message: string | null = null, anonymousVerified = false): void {
    clearTimeout(this.expiry);
    this.privateRequests.abort();
    this.privateRequests = new AbortController();
    this.grant = null;
    this.anonymousVerified = anonymousVerified;
    this.snapshot = { status, user: null, message, revision: this.snapshot.revision + 1 };
    this.listeners.forEach((listener) => listener());
  }

  private check(revision: number, signal: AbortSignal): void {
    if (!this.started || signal.aborted || this.snapshot.revision !== revision) throw stale();
  }

  private track(promise: Promise<void>): Promise<void> {
    this.flight = promise;
    const finish = () => {
      if (this.flight === promise) this.flight = null;
      if (this.restoreWanted && this.snapshot.status === 'restoring') this.scheduleRestore();
    };
    void promise.then(finish, finish);
    return promise;
  }

  private scheduleRestore(): void {
    this.restoreWanted = true;
    queueMicrotask(() => {
      if (!this.started || this.flight !== null || !this.restoreWanted || this.snapshot.status !== 'restoring') return;
      this.restoreWanted = false;
      void this.restore().catch(() => { });
    });
  }

  private receive(event: SessionEvent): void {
    if (event === 'guest-recovery-changed') { this.guestRecoveryListeners.forEach((listener) => listener()); return; }
    if (event === 'guest-changed') { this.guestListeners.forEach((listener) => listener()); return; }
    if (this.logoutFlight !== null && event === 'logout-start') return;
    if ((this.logoutFlight !== null || this.snapshot.status === 'logging-out' || this.snapshot.status === 'logout-error')
      && (event === 'changing' || event === 'changed' || event === 'security-changed')) return;
    clearTimeout(this.peerDeadline);
    switch (event) {
      case 'changing':
        this.restoreWanted = false;
        this.invalidate('restoring');
        this.peerDeadline = setTimeout(() => this.invalidate('unavailable', unavailable), 20_000);
        break;
      case 'changed':
      case 'security-changed':
        this.invalidate('restoring'); this.scheduleRestore(); break;
      case 'signed-out':
        this.restoreWanted = false; this.invalidate('anonymous', null, true); break;
      case 'uncertain':
        this.restoreWanted = false; this.invalidate('unavailable', unavailable); break;
      case 'logout-start':
        this.restoreWanted = false; this.invalidate('logging-out');
        this.peerDeadline = setTimeout(() => this.invalidate('logout-error', logoutUnavailable), 20_000);
        break;
      case 'logout-failed':
        this.restoreWanted = false; this.invalidate('logout-error', logoutUnavailable); break;
    }
  }

  subscribeGuest = (listener: () => void) => {
    this.guestListeners.add(listener);
    return () => { this.guestListeners.delete(listener); };
  };

  subscribeGuestRecovery = (listener: () => void) => {
    this.guestRecoveryListeners.add(listener);
    return () => { this.guestRecoveryListeners.delete(listener); };
  };

  notifyGuestRecovery(): void {
    this.guestRecoveryListeners.forEach((listener) => listener());
    this.coordinator?.notify('guest-recovery-changed');
  }

  notifyGuest(): void { this.coordinator?.notify('guest-changed'); }

  async guestCookie<T>(revision: number, lifetime: AbortSignal, operation: (signal: AbortSignal) => Promise<T>, deadline = 10_000): Promise<T> {
    if (this.coordinator === null) throw stale();
    const waiting = new AbortController();
    const active = AbortSignal.any([lifetime, this.privateRequests.signal]);
    const queued = AbortSignal.any([active, waiting.signal]);
    const timer = setTimeout(() => waiting.abort(), 5000);
    try {
      return await this.coordinator.exclusive(queued, async () => {
        clearTimeout(timer);
        this.check(revision, queued);
        return requestDeadline(active, deadline, async (signal) => {
          const result = await operation(signal);
          this.check(revision, signal);
          return result;
        }, stale);
      });
    } finally { clearTimeout(timer); }
  }

  private async cookie<T>(revision: number, options: RequestOptions, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    this.controllers.add(controller);
    const deadline = setTimeout(abort, 20_000);
    try {
      if (this.coordinator === null) throw new ApiRequestError('protocol', 'coordination_unavailable', 'Session access is unavailable in this browser.');
      return await this.coordinator.exclusive(controller.signal, async () => {
        this.check(revision, controller.signal);
        return operation(controller.signal);
      });
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', abort);
      this.controllers.delete(controller);
    }
  }

  private confirm(grant: Grant, user: User): void {
    if (grant.requestedAt + grant.tokens.expires_in * 1000 <= Date.now()) throw stale();
    const previous = this.snapshot.user;
    if (previous?.id !== user.id || previous.role !== user.role) this.invalidate('restoring');
    this.grant = { ...grant, userId: user.id };
    this.set('authenticated', user);
    clearTimeout(this.expiry);
    const current = this.grant;
    this.expiry = setTimeout(() => {
      if (this.grant !== current || !this.started) return;
      this.invalidate('restoring'); this.scheduleRestore();
    }, Math.max(0, grant.requestedAt + grant.tokens.expires_in * 1000 - Date.now()));
  }

  private async identify(grant: Grant, revision: number, signal: AbortSignal): Promise<void> {
    try {
      const user = await this.api.getMe(grant.tokens.access_token, { signal });
      this.check(revision, signal);
      this.confirm(grant, user);
    } catch (error) {
      if (this.snapshot.revision !== revision) throw error;
      if (error instanceof ApiRequestError && error.isAuthenticationFailure) {
        this.invalidate('anonymous');
        throw new ApiRequestError('http', 'session_rejected', 'Your sign-in is no longer valid. Please sign in again.', 401);
      }
      this.invalidate('profile-error', profileUnavailable);
      this.grant = grant;
      throw new ApiRequestError('protocol', 'profile_unavailable', profileUnavailable);
    }
  }

  restore = (force = false): Promise<void> => {
    if (this.flight !== null) return this.flight;
    if (this.coordinator === null) return Promise.reject(new ApiRequestError('protocol', 'coordination_unavailable', 'Session access is unavailable in this browser.'));
    if (this.snapshot.status === 'logout-error' || this.snapshot.status === 'logging-out') return Promise.resolve();
    if (!force && this.snapshot.status === 'authenticated') return Promise.resolve();
    const previous = this.snapshot.user;
    if (previous === null) this.invalidate('restoring');
    else this.set('refreshing', previous);
    const revision = this.snapshot.revision;
    const promise = this.cookie(revision, {}, async (signal) => {
      let grant: Grant;
      try {
        const requestedAt = Date.now();
        const tokens = await this.api.refresh({ signal });
        this.check(revision, signal);
        grant = { tokens, requestedAt, userId: null };
      } catch (error) {
        if (this.snapshot.revision !== revision) throw error;
        if (error instanceof ApiRequestError && error.isAuthenticationFailure) {
          this.invalidate('anonymous', previous === null ? null : 'Your session is no longer available. Please sign in again.', true);
          return;
        }
        this.invalidate('unavailable', unavailable);
        this.coordinator?.notify('uncertain');
        throw error;
      }
      await this.identify(grant, revision, signal);
    }).catch((error: unknown) => {
      if (this.snapshot.revision === revision) this.invalidate('unavailable', unavailable);
      throw error;
    });
    return this.track(promise);
  };

  login = (input: LoginInput, options: RequestOptions = {}): Promise<void> => {
    if (this.flight !== null) return Promise.reject(stale());
    const wasAnonymous = this.canShopAsGuest;
    this.invalidate('signing-in');
    const revision = this.snapshot.revision;
    const promise = this.cookie(revision, options, async (signal) => {
      this.coordinator?.notify('changing');
      let grant: Grant;
      try {
        const requestedAt = Date.now();
        const tokens = await this.api.login(input, { signal });
        this.check(revision, signal);
        grant = { tokens, requestedAt, userId: null };
      } catch (error) {
        if (this.snapshot.revision !== revision) throw error;
        const rejected = error instanceof ApiRequestError && error.kind === 'http' && (error.status ?? 500) < 500;
        this.invalidate(rejected ? 'anonymous' : 'unavailable', rejected ? null : unavailable, rejected && wasAnonymous);
        this.coordinator?.notify(rejected ? 'changed' : 'uncertain');
        throw error;
      }
      try { await this.identify(grant, revision, signal); }
      finally {
        if (this.snapshot.status === 'authenticated' || this.snapshot.status === 'profile-error' || this.snapshot.status === 'anonymous') {
          this.coordinator?.notify('changed');
        }
      }
    }).catch((error: unknown) => {
      if (this.snapshot.revision === revision) this.invalidate('unavailable', unavailable);
      throw error;
    });
    return this.track(promise);
  };

  retryProfile = (): Promise<void> => {
    if (this.flight !== null) return this.flight;
    const grant = this.grant;
    if (grant === null || this.snapshot.status !== 'profile-error') return Promise.reject(stale());
    if (Date.now() >= grant.requestedAt + grant.tokens.expires_in * 1000) {
      this.invalidate('restoring');
      return this.restore();
    }
    this.set('restoring');
    const revision = this.snapshot.revision;
    return this.track(this.cookie(revision, {}, (signal) => this.identify(grant, revision, signal)));
  };

  prepareLogin = (): void => {
    if (this.coordinationAvailable && this.snapshot.status === 'unavailable') this.invalidate('anonymous');
  };

  // Background tabs may suspend timers. Check the conservative deadline again
  // on foreground entry and before sending any authenticated request.
  recheckDeadline = (): void => {
    if (this.snapshot.status !== 'authenticated' || this.grant === null) return;
    if (Date.now() < this.grant.requestedAt + this.grant.tokens.expires_in * 1000) return;
    this.invalidate('restoring');
    this.scheduleRestore();
  };

  logout = (): Promise<void> => {
    if (this.logoutFlight !== null) return this.logoutFlight;
    const previous = this.flight;
    this.restoreWanted = false;
    this.invalidate('logging-out');
    this.coordinator?.notify('logout-start');
    const revision = this.snapshot.revision;
    const promise = (async () => {
      await previous?.catch(() => { });
      try {
        await this.cookie(revision, {}, async (signal) => {
          await this.api.logout({ signal });
          this.check(revision, signal);
          this.invalidate('anonymous', null, true);
          this.coordinator?.notify('signed-out');
        });
      } catch (error) {
        if (this.snapshot.revision === revision) {
          this.invalidate('logout-error', logoutUnavailable);
          this.coordinator?.notify('logout-failed');
        }
        throw error;
      }
    })();
    this.logoutFlight = promise;
    void promise.then(() => { this.logoutFlight = null; }, () => { this.logoutFlight = null; });
    return this.track(promise);
  };

  authorized = async <T>(operation: (accessToken: string, options: RequestOptions) => Promise<T>, options: RequestOptions = {}): Promise<T> => {
    this.recheckDeadline();
    if (this.snapshot.status === 'restoring' && this.flight === null) await this.restore();
    if (this.flight !== null) await this.flight;
    if (this.snapshot.status !== 'authenticated' || this.grant === null) throw stale();
    const revision = this.snapshot.revision;
    const userId = this.snapshot.user?.id;
    const first = this.grant;
    const signal = AbortSignal.any([this.privateRequests.signal, ...(options.signal ? [options.signal] : [])]);
    this.check(revision, signal);
    try {
      const result = await operation(first.tokens.access_token, { signal });
      this.check(revision, signal);
      return result;
    } catch (error) {
      this.check(revision, signal);
      if (!(error instanceof ApiRequestError) || !error.isAuthenticationFailure) throw error;
    }
    if (this.grant === first) await this.restore(true);
    if (this.snapshot.revision !== revision || this.snapshot.user?.id !== userId || this.grant === null) throw stale();
    this.check(revision, signal);
    try {
      const result = await operation(this.grant.tokens.access_token, { signal });
      this.check(revision, signal);
      return result;
    } catch (error) {
      this.check(revision, signal);
      if (error instanceof ApiRequestError && error.isAuthenticationFailure) this.invalidate('anonymous', 'Your session is no longer available. Please sign in again.');
      throw error;
    }
  };

  confirmPasswordReset = async (input: PasswordResetInput, options: RequestOptions = {}): Promise<SecurityChangeResult> => {
    // Wait for an already-running cookie operation, then submit once under the
    // same origin lock. Public recovery never enters the authenticated replay path.
    if (this.flight !== null) await this.flight.catch(() => { });
    const revision = this.snapshot.revision;
    let result: SecurityChangeResult | null = null;
    const promise = this.cookie(revision, options, async (signal) => {
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new ApiRequestError('cancelled', 'security_outcome_unknown', 'The reset may have completed. Sign in deliberately to check.'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      try {
        result = await Promise.race([this.api.confirmPasswordReset(input, { signal }), cancelled]);
        this.receive('security-changed');
        this.coordinator?.notify('security-changed');
      } finally { signal.removeEventListener('abort', abort); }
    }).catch((error: unknown) => {
      const rejected = error instanceof ApiRequestError && error.kind === 'http' && error.status !== null && error.status >= 400 && error.status < 500;
      if (!rejected && this.snapshot.revision === revision) {
        this.restoreWanted = false;
        this.invalidate('unavailable', 'We couldn’t confirm the password reset. Sign in deliberately or check your session; the reset will not repeat automatically.');
      }
      throw error;
    });
    await this.track(promise);
    if (result === null) throw stale();
    return result;
  };

  changePasswordFor = (revision: number, input: PasswordChangeInput, options: RequestOptions = {}): Promise<void> => {
    this.recheckDeadline();
    if (this.snapshot.revision !== revision || this.snapshot.status !== 'authenticated' || this.grant === null || this.flight !== null) {
      return Promise.reject(stale());
    }
    const token = this.grant.tokens.access_token;
    const promise = this.cookie(revision, options, async (signal) => {
      this.coordinator?.notify('changing');
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new ApiRequestError('cancelled', 'security_outcome_unknown', 'The password change may have completed. Sign in deliberately to check.'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      try {
        // Security writes never enter authorized(), including its 401 replay.
        const result: SecurityChangeResult = await Promise.race([this.api.changePassword(token, input, { signal }), cancelled]);
        this.check(revision, signal);
        this.invalidate('anonymous', result.notification === 'unconfirmed'
          ? 'Your password was changed. Notification delivery is unconfirmed. Sign in with your new password.'
          : 'Your password was changed. Sign in with your new password.');
        this.coordinator?.notify('signed-out');
      } finally {
        signal.removeEventListener('abort', abort);
      }
    }).catch((error: unknown) => {
      if (this.snapshot.revision !== revision) throw error;
      const failure = error instanceof ApiRequestError ? error : null;
      const rejected = failure?.kind === 'http' && failure.status !== null && failure.status >= 400 && failure.status < 500;
      if (failure?.isAuthenticationFailure) {
        this.invalidate('anonymous', 'Your session was rejected. The password change was not retried. Sign in again.');
        this.coordinator?.notify('changed');
      } else if (rejected) {
        this.coordinator?.notify('changed');
      } else {
        this.restoreWanted = false;
        this.invalidate('unavailable', 'We couldn’t confirm whether your password changed. Sign in deliberately with the new or current password to check; the change will not repeat automatically.');
        this.coordinator?.notify('uncertain');
      }
      throw error;
    });
    return this.track(promise);
  };

  private securityMailWrite<T>(revision: number, operation: (token: string, signal: AbortSignal) => Promise<T>, options: RequestOptions): Promise<T> {
    this.recheckDeadline();
    if (this.snapshot.revision !== revision || this.snapshot.status !== 'authenticated' || this.grant === null || this.flight !== null) return Promise.reject(stale());
    const token = this.grant.tokens.access_token;
    return this.cookie(revision, options, async (signal) => {
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new ApiRequestError('cancelled', 'security_outcome_unknown', 'The security request may have completed. Check your account before another submission.'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      try {
        const result = await Promise.race([operation(token, signal), cancelled]);
        this.check(revision, signal);
        return result;
      } finally { signal.removeEventListener('abort', abort); }
    }).catch((error: unknown) => {
      if (this.snapshot.revision === revision && error instanceof ApiRequestError && error.isAuthenticationFailure) {
        this.invalidate('anonymous', 'Your session was rejected. The security request was not retried. Sign in again and reopen the email if needed.');
      }
      throw error;
    });
  }

  requestVerificationFor = (revision: number, input: { current_password: string }, options: RequestOptions = {}): Promise<MailRequestResult> =>
    this.securityMailWrite(revision, (token, signal) => this.api.requestVerification(token, input, { signal }), options);

  confirmVerificationFor = async (revision: number, input: VerificationInput, options: RequestOptions = {}): Promise<User> => {
    const user = await this.securityMailWrite(revision, (token, signal) => this.api.confirmVerification(token, input, { signal }), options);
    return this.confirmProfile(revision, user);
  };

  requestEmailChangeFor = (revision: number, input: EmailChangeInput, options: RequestOptions = {}): Promise<MailRequestResult> =>
    this.securityMailWrite(revision, (token, signal) => this.api.requestEmailChange(token, input, { signal }), options);

  cancelEmailChangeFor = (revision: number, input: EmailChangeCancellation, options: RequestOptions = {}): Promise<void> =>
    this.securityMailWrite(revision, (token, signal) => this.api.cancelEmailChange(token, input, { signal }), options);

  confirmEmailChangeFor = (revision: number, input: VerificationInput, options: RequestOptions = {}): Promise<EmailChangeResult> => {
    this.recheckDeadline();
    if (this.snapshot.revision !== revision || this.snapshot.status !== 'authenticated' || this.grant === null || this.flight !== null) return Promise.reject(stale());
    const token = this.grant.tokens.access_token;
    let confirmed: EmailChangeResult | null = null;
    const promise = this.cookie(revision, options, async (signal) => {
      this.coordinator?.notify('changing');
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new ApiRequestError('cancelled', 'security_outcome_unknown', 'The email change may have completed. Sign in deliberately to check.'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      try {
        const result = await Promise.race([this.api.confirmEmailChange(token, input, { signal }), cancelled]);
        this.check(revision, signal);
        confirmed = result;
        if ('status' in result) {
          this.coordinator?.notify('changed');
        } else {
          this.invalidate('anonymous', result.notification === 'unconfirmed'
            ? 'Your email was changed. Notification delivery is unconfirmed. Sign in with your new email and existing password.'
            : 'Your email was changed. Sign in with your new email and existing password.');
          this.coordinator?.notify('signed-out');
        }
      } finally { signal.removeEventListener('abort', abort); }
    }).catch((error: unknown) => {
      if (this.snapshot.revision !== revision) throw error;
      const failure = error instanceof ApiRequestError ? error : null;
      if (failure?.isAuthenticationFailure) {
        this.invalidate('anonymous', 'Your session was rejected. The email confirmation was not retried. Sign in again and reopen the email.');
        this.coordinator?.notify('changed');
      } else if (failure?.kind === 'http' && failure.status !== null && failure.status >= 400 && failure.status < 500) {
        this.coordinator?.notify('changed');
      } else {
        this.restoreWanted = false;
        this.invalidate('unavailable', 'We couldn’t confirm whether your email changed. Sign in deliberately with the proposed or current email to check. The confirmation will not repeat automatically.');
        this.coordinator?.notify('uncertain');
      }
      throw error;
    });
    return this.track(promise).then(() => {
      if (confirmed === null) throw stale();
      return confirmed;
    });
  };

  // A retained UI callback must not submit an old user's intent with a new
  // user's credentials, even when it starts after that identity change.
  authorizedFor = <T>(revision: number, operation: (accessToken: string, options: RequestOptions) => Promise<T>, options: RequestOptions = {}): Promise<T> => {
    if (this.snapshot.revision !== revision) return Promise.reject(stale());
    return this.authorized((token, requestOptions) => {
      if (this.snapshot.revision !== revision) throw stale();
      return operation(token, requestOptions);
    }, options);
  };

  // Commerce mutations have no idempotency key. Send once, with the
  // current identity pinned; reconciliation belongs to a separate explicit read.
  writeFor = async <T>(revision: number, operation: (accessToken: string, options: RequestOptions) => Promise<T>, options: RequestOptions = {}): Promise<T> => {
    this.recheckDeadline();
    if (this.snapshot.revision !== revision || this.snapshot.status !== 'authenticated' || this.grant === null || this.flight !== null) throw stale();
    const signal = AbortSignal.any([this.privateRequests.signal, ...(options.signal ? [options.signal] : [])]);
    this.check(revision, signal);
    try {
      const result = await operation(this.grant.tokens.access_token, { signal });
      this.check(revision, signal);
      return result;
    } catch (error) {
      this.check(revision, signal);
      if (error instanceof ApiRequestError && error.isAuthenticationFailure) this.invalidate('anonymous', 'Your session was rejected. The change was not retried. Sign in again and review your saved data.');
      throw error;
    }
  };

  private confirmProfile(revision: number, user: User): User {
    if (this.snapshot.revision !== revision || this.grant === null) throw stale();
    if (user.id !== this.snapshot.user?.id) {
      throw new ApiRequestError('protocol', 'unexpected_profile', 'The server returned an unexpected account. Reload your profile before trying again.');
    }
    this.confirm(this.grant, user);
    return user;
  }

  readProfileFor = async (revision: number, options: RequestOptions = {}): Promise<User> => {
    const user = await this.authorizedFor(revision, (token, requestOptions) => this.api.getMe(token, requestOptions), options);
    return this.confirmProfile(revision, user);
  };

  updateProfileFor = async (revision: number, input: ProfilePatch, options: RequestOptions = {}): Promise<User> => {
    const user = await this.authorizedFor(revision, (token, requestOptions) => this.api.updateMe(token, input, requestOptions), options);
    return this.confirmProfile(revision, user);
  };

  checkIdentity = async (options: RequestOptions = {}): Promise<void> => {
    await this.readProfileFor(this.snapshot.revision, options);
  };
}

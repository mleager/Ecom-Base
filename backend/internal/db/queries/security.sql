-- name: LockPendingEmailRequests :many
SELECT id FROM email_change_requests WHERE user_id=$1 AND state='pending' ORDER BY id FOR UPDATE;

-- name: LockSecurityTokens :many
SELECT id FROM account_security_tokens WHERE user_id=$1 ORDER BY id FOR UPDATE;

-- name: InvalidateSecurityTokens :exec
UPDATE account_security_tokens SET invalidated_at=clock_timestamp()
WHERE user_id=$1 AND consumed_at IS NULL AND invalidated_at IS NULL;

-- name: CancelPendingEmailRequests :exec
UPDATE email_change_requests SET state='cancelled',finished_at=clock_timestamp() WHERE user_id=$1 AND state='pending';

-- name: InvalidateVerificationTokens :exec
UPDATE account_security_tokens SET invalidated_at=clock_timestamp()
WHERE user_id=$1 AND purpose='verify_email' AND consumed_at IS NULL AND invalidated_at IS NULL;

-- name: VerificationIssueBudget :one
SELECT count(*)::bigint AS issued, COALESCE(max(created_at)>clock_timestamp()-interval '60 seconds',false)::boolean AS cooling_down
FROM account_security_tokens WHERE user_id=$1 AND purpose='verify_email' AND created_at>clock_timestamp()-interval '1 hour';

-- name: CreateVerificationToken :exec
INSERT INTO account_security_tokens(id,user_id,token_hash,purpose,email,credential_version,expires_at)
VALUES($1,$2,$3,'verify_email',$4,$5,clock_timestamp()+interval '30 minutes');

-- name: FindVerificationToken :one
SELECT * FROM account_security_tokens WHERE token_hash=$1 AND purpose='verify_email';

-- name: ConsumeVerificationToken :execrows
UPDATE account_security_tokens SET consumed_at=clock_timestamp()
WHERE id=$1 AND user_id=$2 AND purpose='verify_email' AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at>clock_timestamp();

-- name: MarkEmailVerified :exec
UPDATE users SET email_verified_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1;

-- name: VerificationDeliverable :one
SELECT EXISTS(SELECT 1 FROM account_security_tokens t JOIN users u ON u.id=t.user_id
 WHERE t.id=$1 AND t.purpose='verify_email' AND t.consumed_at IS NULL AND t.invalidated_at IS NULL
 AND t.expires_at>clock_timestamp() AND u.is_active AND u.email=t.email AND u.credential_version=t.credential_version
 AND u.email_verified_at IS NULL);

-- name: GetPendingEmailChange :one
SELECT id,new_email,expires_at,(old_confirmed_at IS NOT NULL)::boolean AS old_confirmed,(new_confirmed_at IS NOT NULL)::boolean AS new_confirmed
FROM email_change_requests WHERE user_id=$1 AND state='pending' AND expires_at>clock_timestamp();

-- name: EmailChangeIssueBudget :one
-- Each request issues exactly one old-mailbox proof. Its retained issuance row
-- supplies the request budget through the existing user/purpose/creation index.
SELECT count(*)::bigint AS issued, COALESCE(max(created_at)>clock_timestamp()-interval '60 seconds',false)::boolean AS cooling_down
FROM account_security_tokens WHERE user_id=$1 AND purpose='email_change_old' AND created_at>clock_timestamp()-interval '1 hour';

-- name: ExpirePendingEmailRequests :exec
UPDATE email_change_requests SET state='expired',finished_at=clock_timestamp()
WHERE user_id=$1 AND state='pending' AND expires_at<=clock_timestamp();

-- name: InvalidateEmailChangeTokens :exec
UPDATE account_security_tokens SET invalidated_at=clock_timestamp()
WHERE user_id=$1 AND purpose IN ('email_change_old','email_change_new') AND consumed_at IS NULL AND invalidated_at IS NULL;

-- name: CreateEmailChangeRequest :one
INSERT INTO email_change_requests(id,user_id,old_email,new_email,credential_version,expires_at)
VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '30 minutes') RETURNING *;

-- name: CreateEmailChangeToken :exec
INSERT INTO account_security_tokens(id,user_id,token_hash,purpose,email,credential_version,change_request_id,expires_at)
VALUES($1,$2,$3,$4,$5,$6,$7,$8);

-- name: FindEmailChangeToken :one
SELECT * FROM account_security_tokens WHERE token_hash=$1 AND purpose IN ('email_change_old','email_change_new');

-- name: FindEmailChangeRequest :one
SELECT *, (expires_at>clock_timestamp())::boolean AS unexpired FROM email_change_requests WHERE id=$1 AND user_id=$2;

-- name: ConsumeEmailChangeToken :execrows
UPDATE account_security_tokens SET consumed_at=clock_timestamp()
WHERE id=$1 AND user_id=$2 AND purpose IN ('email_change_old','email_change_new') AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at>clock_timestamp();

-- name: RecordEmailChangeOldProof :execrows
UPDATE email_change_requests SET old_confirmed_at=clock_timestamp()
WHERE id=$1 AND user_id=$2 AND state='pending' AND expires_at>clock_timestamp() AND old_confirmed_at IS NULL;

-- name: RecordEmailChangeNewProof :execrows
UPDATE email_change_requests SET new_confirmed_at=clock_timestamp()
WHERE id=$1 AND user_id=$2 AND state='pending' AND expires_at>clock_timestamp() AND new_confirmed_at IS NULL;

-- name: FinishEmailChangeRequest :execrows
UPDATE email_change_requests SET state=$3,finished_at=clock_timestamp()
WHERE id=$1 AND user_id=$2 AND state='pending' AND expires_at>clock_timestamp();

-- name: CompleteEmailChangeProofs :execrows
UPDATE email_change_requests SET state=$3,finished_at=clock_timestamp(),
 old_confirmed_at=COALESCE(old_confirmed_at,clock_timestamp()),new_confirmed_at=COALESCE(new_confirmed_at,clock_timestamp())
WHERE id=$1 AND user_id=$2 AND state='pending' AND expires_at>clock_timestamp();

-- name: InvalidateEmailChangeRequestTokens :exec
UPDATE account_security_tokens SET invalidated_at=clock_timestamp()
WHERE change_request_id=$1 AND user_id=$2 AND consumed_at IS NULL AND invalidated_at IS NULL;

-- name: ReplaceVerifiedEmail :execrows
UPDATE users SET email=$2,email_verified_at=clock_timestamp(),credential_version=credential_version+1,updated_at=clock_timestamp()
WHERE id=$1 AND credential_version=$3 AND credential_version<9223372036854775807;

-- name: EmailChangeDeliverable :one
SELECT EXISTS(SELECT 1 FROM email_change_requests r JOIN users u ON u.id=r.user_id
 WHERE r.id=$1 AND r.state='pending' AND r.expires_at>clock_timestamp() AND u.is_active
 AND u.email_verified_at IS NOT NULL AND u.email=r.old_email AND u.credential_version=r.credential_version
 AND (SELECT count(*) FROM account_security_tokens t WHERE t.change_request_id=r.id AND t.user_id=u.id
 AND t.credential_version=u.credential_version AND t.consumed_at IS NULL AND t.invalidated_at IS NULL AND t.expires_at>clock_timestamp()
 AND ((t.purpose='email_change_old' AND t.email=r.old_email) OR (t.purpose='email_change_new' AND t.email=r.new_email)))=2);

-- name: PasswordResetIssueBudget :one
SELECT count(*) FILTER (WHERE created_at>clock_timestamp()-interval '1 hour')::bigint AS issued,
 count(*) FILTER (WHERE consumed_at IS NULL AND invalidated_at IS NULL AND expires_at>clock_timestamp())::bigint AS live
FROM account_security_tokens WHERE user_id=$1 AND purpose='reset_password'
 AND (created_at>clock_timestamp()-interval '1 hour' OR (consumed_at IS NULL AND invalidated_at IS NULL AND expires_at>clock_timestamp()));

-- name: CreatePasswordResetToken :exec
INSERT INTO account_security_tokens(id,user_id,token_hash,purpose,email,credential_version,expires_at)
VALUES($1,$2,$3,'reset_password',$4,$5,clock_timestamp()+interval '15 minutes');

-- name: FindPasswordResetToken :one
SELECT *, (expires_at>clock_timestamp())::boolean AS unexpired
FROM account_security_tokens WHERE token_hash=$1 AND purpose='reset_password';

-- name: ConsumePasswordResetToken :execrows
UPDATE account_security_tokens SET consumed_at=clock_timestamp()
WHERE id=$1 AND user_id=$2 AND purpose='reset_password' AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at>clock_timestamp();

-- name: PasswordResetDeliverable :one
SELECT EXISTS(SELECT 1 FROM account_security_tokens t JOIN users u ON u.id=t.user_id
 WHERE t.id=$1 AND t.purpose='reset_password' AND t.consumed_at IS NULL AND t.invalidated_at IS NULL
 AND t.expires_at>clock_timestamp() AND u.is_active AND u.email_verified_at IS NOT NULL
 AND u.email=t.email AND u.credential_version=t.credential_version);

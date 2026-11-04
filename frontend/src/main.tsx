import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './app/App';
import './styles.css';
import { captureVerificationIntent, createVerificationIntentStore, installVerificationNavigation } from './features/account/VerificationIntent';

const verificationIntentStore = createVerificationIntentStore(captureVerificationIntent(window.location, window.history));
const removeVerificationNavigation = installVerificationNavigation(verificationIntentStore, window);
if (import.meta.hot) import.meta.hot.dispose(removeVerificationNavigation);

const root = document.getElementById('root');

if (root === null) {
  throw new Error('The application root element is missing.');
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App verificationIntentStore={verificationIntentStore} />
    </BrowserRouter>
  </StrictMode>,
);

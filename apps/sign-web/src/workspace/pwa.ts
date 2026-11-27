// SIGN-FREE-PARITY-1 S8 — installable web app. The workspace entry registers the
// service worker (public/sw.js) in production builds only; the guest entry never does.
// The worker caches static build files only (custody rule; see public/sw.js).

interface ServiceWorkerHost {
  serviceWorker?: Pick<ServiceWorkerContainer, 'register'>;
}

/** Registers /sw.js once the page has loaded. Returns false when it was not registered. */
export function registerServiceWorker(
  isProduction: boolean,
  nav: ServiceWorkerHost = navigator,
  win: Pick<Window, 'addEventListener'> & { document: Pick<Document, 'readyState'> } = window,
): boolean {
  if (!isProduction) return false;
  const container = nav.serviceWorker;
  if (container === undefined) return false;
  const register = (): void => {
    // A refused registration only means the app is not installable; the site works as before.
    container.register('/sw.js', { scope: '/' }).catch(() => undefined);
  };
  if (win.document.readyState === 'complete') register();
  else win.addEventListener('load', register, { once: true });
  return true;
}

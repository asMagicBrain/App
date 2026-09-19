const routers = new WeakMap();

/** One IPC subscription spans startup and the shared UI; replacement is synchronous. */
export function installNativeCloseRouter(bridge) {
  let router = routers.get(bridge);
  if (router) return router;
  const startup = input => {if (!input.cancelled) bridge.closeReady({requestId: input.requestId, ok: true});};
  router = {current: startup, startup};
  routers.set(bridge, router);
  bridge.onPrepareClose(input => {void router.current(input);});
  return router;
}

export function registerNativeCloseHandler(bridge, handler) {
  const router = installNativeCloseRouter(bridge);
  router.current = handler;
  return () => {if (router.current === handler) router.current = router.startup;};
}

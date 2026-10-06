const tabId = Number(chrome.devtools?.inspectedWindow?.tabId);
let port = null;
let closing = false;

function sendPresence(type) {
  if (!Number.isSafeInteger(tabId)) return;
  chrome.runtime.sendMessage({ type, tabId, source: 'devtools-page' }).catch(() => {});
}

function connect() {
  if (closing || !Number.isSafeInteger(tabId)) return;
  port = chrome.runtime.connect({ name: `jshotz-devtools:${tabId}` });
  port.onDisconnect.addListener(() => {
    port = null;
    if (!closing) setTimeout(connect, 250);
  });
  sendPresence('DEVTOOLS_HEARTBEAT');
}

if (Number.isSafeInteger(tabId)) {
  connect();
  setInterval(() => sendPresence('DEVTOOLS_HEARTBEAT'), 1000);
  window.addEventListener('pagehide', () => {
    closing = true;
    sendPresence('DEVTOOLS_CLOSED');
  });
}

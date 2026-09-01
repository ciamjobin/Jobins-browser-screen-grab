// Chromium only: bridges the service worker to the canvas module, which needs a DOM.
import { handlers } from './image-worker.js';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  const handler = handlers[message.type];
  if (!handler) {
    sendResponse({ error: `Unknown offscreen message: ${message.type}` });
    return true;
  }

  Promise.resolve(handler(message))
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message }));
  return true;
});

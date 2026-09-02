// Runs in the page's MAIN world so it can wrap the page's own fetch/XHR and read response bodies.
(() => {
  const MAX_BODY = 6000;

  function trim(text) {
    const value = String(text ?? '');
    return value.length > MAX_BODY
      ? `${value.slice(0, MAX_BODY)}\n\n... truncated (${value.length} chars total)`
      : value;
  }

  function headersToText(headers) {
    if (!headers) return '(none)';
    try {
      if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
        const lines = [];
        headers.forEach((value, name) => lines.push(`${name}: ${value}`));
        return lines.join('\n') || '(none)';
      }
      const entries = Array.isArray(headers) ? headers : Object.entries(headers);
      return entries.map(([name, value]) => `${name}: ${value}`).join('\n') || '(none)';
    } catch {
      return '(headers unavailable)';
    }
  }

  // fetch/XHR are usually called with a relative path, so resolve before filtering.
  function absoluteUrl(url) {
    try {
      return new URL(String(url ?? ''), location.href).href;
    } catch {
      return String(url ?? '');
    }
  }

  function post(detail) {
    const url = absoluteUrl(detail.url);
    if (!/^https?:/i.test(url)) return;
    let target;
    try {
      target = new URL(url);
    } catch {
      target = null;
    }
    window.postMessage(
      {
        source: 'flow-recorder-api',
        detail: {
          ...detail,
          url,
          pageUrl: location.href,
          pageOrigin: location.origin,
          pageReferrer: document.referrer || '',
          targetOrigin: target?.origin || '',
          targetHost: target?.host || ''
        }
      },
      '*'
    );
  }

  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const options = init || {};
    const url = typeof input === 'string' ? input : input?.url;
    const method = String(options.method || input?.method || 'GET').toUpperCase();
    const requestHeaders = headersToText(options.headers || input?.headers);
    const payload =
      typeof options.body === 'string' ? trim(options.body) : options.body ? '(non-text body)' : '(no request body)';

    let response;
    try {
      response = await originalFetch.apply(this, arguments);
    } catch (error) {
      post({
        outcome: 'failure',
        url,
        method,
        status: 0,
        requestHeaders,
        payload,
        responseHeaders: '(none)',
        body: `Request failed: ${error.message}`
      });
      throw error;
    }

    try {
      const body = await response.clone().text();
      post({
        outcome: response.ok ? 'success' : 'failure',
        url,
        method,
        status: response.status,
        requestHeaders,
        payload,
        responseHeaders: headersToText(response.headers),
        body: trim(body)
      });
    } catch {
      /* Streamed or already-consumed bodies cannot be cloned. */
    }

    return response;
  };

  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__flowRecorder = { method: String(method || 'GET').toUpperCase(), url: String(url || ''), headers: [] };
    return open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    this.__flowRecorder?.headers.push(`${name}: ${value}`);
    return setRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const info = this.__flowRecorder;
    if (info) {
      info.payload = typeof body === 'string' ? trim(body) : body ? '(non-text body)' : '(no request body)';

      this.addEventListener('loadend', () => {
        let text;
        try {
          text =
            this.responseType === '' || this.responseType === 'text'
              ? this.responseText
              : `(${this.responseType} response)`;
        } catch {
          text = '(response body unavailable)';
        }

        post({
          outcome: this.status >= 200 && this.status < 300 ? 'success' : 'failure',
          url: info.url,
          method: info.method,
          status: this.status,
          requestHeaders: info.headers.join('\n') || '(none)',
          payload: info.payload,
          responseHeaders: this.getAllResponseHeaders() || '(none)',
          body: this.status === 0 ? 'Request failed before a response was received.' : trim(text)
        });
      });
    }
    return send.apply(this, arguments);
  };

  // The DOM is shared with the isolated world, so this is a reliable "hook installed" flag.
  document.documentElement.setAttribute('data-flow-recorder-hook', '1');
})();

// Installed temporarily by diagnose.py. Runs only on the extension's global page.
(function () {
  if (window.__wexLocalDiagnostics) return;
  var endpoint = __ENDPOINT__;
  var nativeFetch = window.fetch.bind(window);
  var client = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  var queue = [];
  var stopped = false;
  var timer;
  var requestController;
  var failures = 0;

  function describe(value) {
    if (value instanceof Error) value = {message: value.message, stack: value.stack};
    try {
      var text = JSON.stringify(value);
      if (text === undefined) return null;
      if (text.length > 16000) return {truncated: true, preview: text.slice(0, 16000)};
      return JSON.parse(text);
    } catch (_) { return String(value).slice(0, 16000); }
  }
  function send(event) {
    if (!stopped && queue.length < 100) queue.push(describe(event));
  }
  function onError(event) {
    if (event.message) send({type: 'error', message: event.message, file: event.filename, line: event.lineno});
  }
  function onRejection(event) {
    send({type: 'rejection', error: describe(event.reason)});
  }
  function stop() {
    stopped = true;
    clearTimeout(timer);
    if (requestController) requestController.abort();
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    window.removeEventListener('unload', stop);
    delete window.__wexLocalDiagnostics;
  }
  window.__wexLocalDiagnostics = {send: send, stop: stop};
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  window.addEventListener('unload', stop);
  send({type: 'connected', url: location.href});

  async function request(path, init) {
    requestController = new AbortController();
    var timeout = setTimeout(function () { requestController.abort(); }, 10000);
    try {
      var response = await nativeFetch(endpoint + path, Object.assign({signal: requestController.signal}, init || {}));
      if (!response.ok) throw new Error('Diagnostic HTTP ' + response.status);
      return await response.json();
    } finally {
      clearTimeout(timeout);
      requestController = null;
    }
  }
  async function execute(job) {
    var timeout;
    try {
      var value = await Promise.race([
        Promise.resolve((0, eval)(job.code)),
        new Promise(function (_, reject) {
          timeout = setTimeout(function () { reject(new Error('Diagnostic timeout (script not cancelled)')); }, 15000);
        })
      ]);
      send({type: 'result', id: job.id, name: job.name, value: describe(value)});
    } catch (error) {
      send({type: 'result', id: job.id, name: job.name, error: describe(error)});
    } finally { clearTimeout(timeout); }
  }
  async function poll() {
    if (stopped) return;
    try {
      if (queue.length) {
        var events = queue.splice(0, 10);
        try {
          await request('/events', {method: 'POST', headers: {'Content-Type': 'text/plain'},
            body: JSON.stringify({client: client, events: events})});
        } catch (error) {
          queue = events.concat(queue).slice(0, 100);
          throw error;
        }
      }
      var reply = await request('/poll');
      if (reply.stop) { stop(); return; }
      for (var job of reply.jobs) {
        if (stopped) break;
        await execute(job);
      }
      failures = 0;
    } catch (_) {
      // A terminated server must not leave a permanent polling loop behind.
      if (++failures >= 10) stop();
    }
    if (!stopped) timer = setTimeout(poll, 1500);
  }
  // Avoid competing with the extension's own startup requests. All traffic
  // is serial, and console methods are deliberately left untouched.
  timer = setTimeout(poll, 5000);
})();

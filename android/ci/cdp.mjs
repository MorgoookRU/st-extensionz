// Evaluates a JS expression in the app's WebView over the DevTools protocol (the port is forwarded
// by emulator-test.sh from the webview_devtools_remote socket). Prints the result as JSON.
const [port, expression] = process.argv.slice(2);
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = pages.find(p => p.type === 'page' && p.url.includes('127.0.0.1')) ?? pages[0];
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
const reply = await new Promise(resolve => { socket.onmessage = e => resolve(JSON.parse(e.data)); });
console.log(JSON.stringify(reply.result?.result?.value ?? reply.result ?? reply));
socket.close();

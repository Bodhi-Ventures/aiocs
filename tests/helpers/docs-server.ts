import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

type RunningServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

function renderLayout(title: string, body: string, extraScript = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
  </head>
  <body>
    ${body}
    <script>
      ${extraScript}
    </script>
  </body>
</html>`;
}

export async function startDocsServer(): Promise<RunningServer> {
  const server = createServer((request, response) => {
    const url = request.url ?? '/';

    if (url === '/selector/start') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'Selector Start',
        `
          <article>
            <h1>Selector Start</h1>
            <p>Maker flow documentation starts here.</p>
          </article>
          <a href="/selector/next">Next page</a>
        `,
      ));
      return;
    }

    if (url === '/selector/next') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'Selector Next',
        `
          <article>
            <h1>Selector Next</h1>
            <p>Second page content for market making docs.</p>
          </article>
        `,
      ));
      return;
    }

    if (url === '/clipboard/start') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'Clipboard Start',
        `
          <button id="copy-page">Copy page</button>
          <a href="/clipboard/next">Next page</a>
        `,
        `
          window.navigator.clipboard ??= {};
          document.getElementById('copy-page')?.addEventListener('click', async () => {
            await navigator.clipboard.writeText('# Clipboard Start\\n\\nClipboard-driven maker flow docs.');
          });
        `,
      ));
      return;
    }

    if (url === '/clipboard/next') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'Clipboard Next',
        `
          <button id="copy-page">Copy page</button>
        `,
        `
          window.navigator.clipboard ??= {};
          document.getElementById('copy-page')?.addEventListener('click', async () => {
            await navigator.clipboard.writeText('# Clipboard Next\\n\\nSecond clipboard docs page.');
          });
        `,
      ));
      return;
    }

    if (url === '/readability/start') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'Readability Start',
        `
          <main>
            <article>
              <h1>Readability Start</h1>
              <p>Readable page content for fallback extraction.</p>
            </article>
          </main>
        `,
      ));
      return;
    }

    response.statusCode = 404;
    response.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

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

    if (url === '/selector-missing/start') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'Selector Missing Start',
        `
          <article>
            <h1>Selector Missing Start</h1>
            <p>Only the valid page should be indexed.</p>
          </article>
          <a href="/selector-missing/missing">Broken page</a>
        `,
      ));
      return;
    }

    if (url === '/selector-missing/missing') {
      response.statusCode = 404;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        '404 Not Found',
        `
          <main>
            <h1>404 Not Found</h1>
            <p>This page should be skipped by the crawler.</p>
          </main>
        `,
      ));
      return;
    }

    if (url === '/selector-gitbook/start') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'Selector GitBook Start',
        `
          <article>
            <h1>Selector GitBook Start</h1>
            <p>GitBook internal export pages should be ignored.</p>
          </article>
          <a href="/~gitbook/pdf?page=test">GitBook export</a>
        `,
      ));
      return;
    }

    if (url === '/selector-raw-mirror/start') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'Selector Raw Mirror Start',
        `
          <article>
            <h1>Selector Raw Mirror Start</h1>
            <p>Canonical HTML pages should win over mirrored markdown assets.</p>
          </article>
          <a href="/selector-raw-mirror/page">Canonical page</a>
          <a href="/selector-raw-mirror/page.md">Raw mirror</a>
        `,
      ));
      return;
    }

    if (url === '/selector-raw-mirror-raw-first/start') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'Selector Raw Mirror Raw First Start',
        `
          <article>
            <h1>Selector Raw Mirror Raw First Start</h1>
            <p>Raw-first mirror ordering should still prefer the canonical HTML page.</p>
          </article>
          <a href="/selector-raw-mirror/page.md">Raw mirror</a>
          <a href="/selector-raw-mirror/page">Canonical page</a>
        `,
      ));
      return;
    }

    if (url === '/selector-prefer-html-raw-first/start') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'Selector Prefer Html Raw First Start',
        `
          <article>
            <h1>Selector Prefer Html Raw First Start</h1>
            <p>Canonical preference should survive raw-first discovery order.</p>
          </article>
          <a href="/selector-prefer-html-raw-first/page.md">Raw mirror</a>
          <a href="/selector-prefer-html-raw-first/page">Canonical page</a>
        `,
      ));
      return;
    }

    if (url === '/selector-prefer-html-raw-first/page') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'Selector Prefer Html Raw First Page',
        `
          <article>
            <h1>Selector Prefer Html Raw First Page</h1>
            <p>Canonical html content should win when mirrors compete.</p>
          </article>
        `,
      ));
      return;
    }

    if (url === '/selector-prefer-html-raw-first/page.md') {
      response.setHeader('content-type', 'text/markdown; charset=utf-8');
      response.end('# Selector Prefer Html Raw First Page\n\nRaw mirror content should not replace the canonical html page.');
      return;
    }

    if (url === '/selector-raw-mirror/page') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'Selector Raw Mirror Page',
        `
          <article>
            <h1>Selector Raw Mirror Page</h1>
            <p>This content should only appear once in the catalog.</p>
          </article>
        `,
      ));
      return;
    }

    if (url === '/selector-raw-mirror/page.md') {
      response.setHeader('content-type', 'text/markdown; charset=utf-8');
      response.end('# Selector Raw Mirror Page\n\nThis content should only appear once in the catalog.');
      return;
    }

    if (url === '/~gitbook/pdf?page=test') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'GitBook PDF',
        `
          <main>
            <h1>GitBook export shell</h1>
            <p>This page should never be crawled.</p>
          </main>
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

    if (url === '/clipboard-raw/start') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'Clipboard Raw Start',
        `
          <button id="copy-page">Copy page</button>
          <a href="/clipboard-raw/raw.md">Raw markdown</a>
        `,
        `
          window.navigator.clipboard ??= {};
          document.getElementById('copy-page')?.addEventListener('click', async () => {
            await navigator.clipboard.writeText('# Clipboard Raw Start\\n\\nHTML page links to a raw markdown asset.');
          });
        `,
      ));
      return;
    }

    if (url === '/clipboard-raw/raw.md') {
      response.setHeader('content-type', 'text/markdown; charset=utf-8');
      response.end('# Raw Markdown Page\n\nThis markdown asset should be ingested directly.');
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

    if (url === '/clipboard-advanced/start') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'Clipboard Advanced Start',
        `
          <style>
            .cta {
              position: relative;
              display: inline-flex;
              align-items: center;
              gap: 8px;
            }

            #menu-trigger,
            #copy-menu-item {
              display: none;
            }

            .menu-open #copy-menu-item {
              display: inline-flex;
            }

            @media (min-width: 1400px) {
              .cta:hover #menu-trigger {
                display: inline-flex;
              }
            }
          </style>
          <div class="cta" id="cta-root">
            <a id="chatgpt-link" href="#chatgpt">OpenAI</a>
            <button id="menu-trigger" aria-haspopup="menu" type="button">Chevron Down</button>
          </div>
          <div id="menu-root" role="menu">
            <button id="copy-menu-item" role="menuitem" type="button">Copy page</button>
          </div>
        `,
        `
          window.navigator.clipboard ??= {};
          document.getElementById('menu-trigger')?.addEventListener('click', () => {
            document.body.classList.add('menu-open');
          });
          document.getElementById('copy-menu-item')?.addEventListener('click', async () => {
            await navigator.clipboard.writeText('# Clipboard Advanced Start\\n\\nDesktop-only markdown copy flow docs.');
          });
        `,
      ));
      return;
    }

    if (url === '/clipboard-same/start') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'Clipboard Same Start',
        `
          <button id="copy-page">Copy page</button>
        `,
        `
          window.navigator.clipboard ??= {};
          const markdown = '# Clipboard Same Start\\n\\nClipboard content stays identical across repeated copies.';
          window.addEventListener('load', async () => {
            await navigator.clipboard.writeText(markdown);
          });
          document.getElementById('copy-page')?.addEventListener('click', async () => {
            await navigator.clipboard.writeText(markdown);
          });
        `,
      ));
      return;
    }

    if (url === '/clipboard-delayed/start') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'Clipboard Delayed Start',
        `
          <button id="copy-page">Copy page</button>
        `,
        `
          window.navigator.clipboard ??= {};
          const markdown = '# Clipboard Delayed Start\\n\\nClipboard handler attaches after hydration.';
          window.setTimeout(() => {
            document.getElementById('copy-page')?.addEventListener('click', async () => {
              await navigator.clipboard.writeText(markdown);
            });
          }, 750);
        `,
      ));
      return;
    }

    if (url === '/clipboard-delayed-menu/start') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'Clipboard Delayed Menu Start',
        `
          <button id="ask-ai">Ask AI</button>
          <div id="menu-root" hidden>
            <div id="copy-markdown" role="button">Copy Markdown</div>
          </div>
        `,
        `
          window.navigator.clipboard ??= {};
          const markdown = '# Clipboard Delayed Menu Start\\n\\nFollow-up copy control appears after a delayed menu action.';
          window.setTimeout(() => {
            document.getElementById('ask-ai')?.addEventListener('click', () => {
              document.getElementById('menu-root')?.removeAttribute('hidden');
            });
          }, 750);
          document.getElementById('copy-markdown')?.addEventListener('click', async () => {
            await navigator.clipboard.writeText(markdown);
          });
        `,
      ));
      return;
    }

    if (url === '/clipboard-delayed-visibility/start') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderLayout(
        'Clipboard Delayed Visibility Start',
        `
          <button id="copy-page" hidden>Copy page</button>
        `,
        `
          window.navigator.clipboard ??= {};
          const markdown = '# Clipboard Delayed Visibility Start\\n\\nSlow controls can still be handled with longer interaction timeouts.';
          window.setTimeout(() => {
            document.getElementById('copy-page')?.removeAttribute('hidden');
          }, 2300);
          document.getElementById('copy-page')?.addEventListener('click', async () => {
            await navigator.clipboard.writeText(markdown);
          });
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

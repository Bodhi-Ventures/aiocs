import { createServer, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

type RunningServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

type RouteDefinition = {
  body: string;
  contentType: string;
  statusCode?: number;
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

function htmlRoute(title: string, body: string, extraScript = ''): RouteDefinition {
  return {
    body: renderLayout(title, body, extraScript),
    contentType: 'text/html; charset=utf-8',
  };
}

function markdownRoute(body: string): RouteDefinition {
  return {
    body,
    contentType: 'text/markdown; charset=utf-8',
  };
}

function routeWithStatus(statusCode: number, route: RouteDefinition): RouteDefinition {
  return {
    ...route,
    statusCode,
  };
}

function sendRoute(response: ServerResponse, route: RouteDefinition): void {
  response.statusCode = route.statusCode ?? 200;
  response.setHeader('content-type', route.contentType);
  response.end(route.body);
}

function createRoutes(): Record<string, RouteDefinition> {
  return {
    '/selector/start': htmlRoute(
      'Selector Start',
      `
        <article>
          <h1>Selector Start</h1>
          <p>Maker flow documentation starts here.</p>
        </article>
        <a href="/selector/next">Next page</a>
      `,
    ),
    '/selector/next': htmlRoute(
      'Selector Next',
      `
        <article>
          <h1>Selector Next</h1>
          <p>Second page content for market making docs.</p>
        </article>
      `,
    ),
    '/selector-v2/start': htmlRoute(
      'Selector Start',
      `
        <article>
          <h1>Selector Start</h1>
          <p>Maker flow documentation starts here with refreshed content.</p>
        </article>
        <a href="/selector-v2/next">Next page</a>
      `,
    ),
    '/selector-v2/next': htmlRoute(
      'Selector Next',
      `
        <article>
          <h1>Selector Next</h1>
          <p>Second page content for market making docs with updated wording.</p>
        </article>
      `,
    ),
    '/selector-missing/start': htmlRoute(
      'Selector Missing Start',
      `
        <article>
          <h1>Selector Missing Start</h1>
          <p>Only the valid page should be indexed.</p>
        </article>
        <a href="/selector-missing/missing">Broken page</a>
      `,
    ),
    '/selector-missing/missing': routeWithStatus(
      404,
      htmlRoute(
        '404 Not Found',
        `
          <main>
            <h1>404 Not Found</h1>
            <p>This page should be skipped by the crawler.</p>
          </main>
        `,
      ),
    ),
    '/selector-gitbook/start': htmlRoute(
      'Selector GitBook Start',
      `
        <article>
          <h1>Selector GitBook Start</h1>
          <p>GitBook internal export pages should be ignored.</p>
        </article>
        <a href="/~gitbook/pdf?page=test">GitBook export</a>
      `,
    ),
    '/selector-flaky/start': htmlRoute(
      'Selector Flaky Start',
      `
        <article>
          <h1>Selector Flaky Start</h1>
          <p>Transient failures should eventually recover.</p>
        </article>
      `,
    ),
    '/selector-always-fail/start': htmlRoute(
      'Selector Always Fail Start',
      `
        <article>
          <h1>Selector Always Fail Start</h1>
          <p>This route should never succeed.</p>
        </article>
      `,
    ),
    '/selector-raw-mirror/start': htmlRoute(
      'Selector Raw Mirror Start',
      `
        <article>
          <h1>Selector Raw Mirror Start</h1>
          <p>Canonical HTML pages should win over mirrored markdown assets.</p>
        </article>
        <a href="/selector-raw-mirror/page">Canonical page</a>
        <a href="/selector-raw-mirror/page.md">Raw mirror</a>
      `,
    ),
    '/selector-raw-mirror/page': htmlRoute(
      'Selector Raw Mirror Page',
      `
        <article>
          <h1>Selector Raw Mirror Page</h1>
          <p>This content should only appear once in the catalog.</p>
        </article>
      `,
    ),
    '/selector-raw-mirror/page.md': markdownRoute(
      '# Selector Raw Mirror Page\n\nThis content should only appear once in the catalog.',
    ),
    '/selector-prefer-html-raw-first/start': htmlRoute(
      'Selector Prefer Html Raw First Start',
      `
        <article>
          <h1>Selector Prefer Html Raw First Start</h1>
          <p>Canonical preference should survive raw-first discovery order.</p>
        </article>
        <a href="/selector-prefer-html-raw-first/page.md">Raw mirror</a>
        <a href="/selector-prefer-html-raw-first/page">Canonical page</a>
      `,
    ),
    '/selector-prefer-html-raw-first/page': htmlRoute(
      'Selector Prefer Html Raw First Page',
      `
        <article>
          <h1>Selector Prefer Html Raw First Page</h1>
          <p>Canonical html content should win when mirrors compete.</p>
        </article>
      `,
    ),
    '/selector-prefer-html-raw-first/page.md': markdownRoute(
      '# Selector Prefer Html Raw First Page\n\nRaw mirror content should not replace the canonical html page.',
    ),
    '/~gitbook/pdf?page=test': htmlRoute(
      'GitBook PDF',
      `
        <main>
          <h1>GitBook export shell</h1>
          <p>This page should never be crawled.</p>
        </main>
      `,
    ),
    '/clipboard/start': htmlRoute(
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
    ),
    '/clipboard/next': htmlRoute(
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
    ),
    '/clipboard-raw/start': htmlRoute(
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
    ),
    '/clipboard-raw/raw.md': markdownRoute(
      '# Raw Markdown Page\n\nThis markdown asset should be ingested directly.',
    ),
    '/readability/start': htmlRoute(
      'Readability Start',
      `
        <main>
          <article>
            <h1>Readability Start</h1>
            <p>Readable page content for fallback extraction.</p>
          </article>
        </main>
      `,
    ),
    '/clipboard-advanced/start': htmlRoute(
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
    ),
    '/clipboard-same/start': htmlRoute(
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
    ),
    '/clipboard-retry/start': htmlRoute(
      'Clipboard Retry Start',
      `
        <button id="copy-page">Copy page</button>
      `,
      `
        window.navigator.clipboard ??= {};
        let attempts = 0;
        const markdown = '# Clipboard Retry Start\\n\\nClipboard copy succeeds after the first interaction does nothing.';
        document.getElementById('copy-page')?.addEventListener('click', async () => {
          attempts += 1;
          if (attempts < 2) {
            return;
          }
          await navigator.clipboard.writeText(markdown);
        });
      `,
    ),
    '/clipboard-retry-menu/start': htmlRoute(
      'Clipboard Retry Menu Start',
      `
        <button id="ask-ai">Ask AI</button>
        <div id="menu-root" hidden>
          <div id="copy-markdown" role="button">Copy Markdown</div>
        </div>
      `,
      `
        window.navigator.clipboard ??= {};
        let menuAttempts = 0;
        const markdown = '# Clipboard Retry Menu Start\\n\\nFollow-up copy control appears after the first full menu sequence fails.';
        document.getElementById('ask-ai')?.addEventListener('click', () => {
          menuAttempts += 1;
          if (menuAttempts < 2) {
            return;
          }
          document.getElementById('menu-root')?.removeAttribute('hidden');
        });
        document.getElementById('copy-markdown')?.addEventListener('click', async () => {
          await navigator.clipboard.writeText(markdown);
        });
      `,
    ),
    '/clipboard-delayed-visibility/start': htmlRoute(
      'Clipboard Delayed Visibility Start',
      `
        <button id="copy-page" hidden>Copy page</button>
      `,
      `
        window.navigator.clipboard ??= {};
        const markdown = '# Clipboard Delayed Visibility Start\\n\\nSlow controls can still be handled with longer interaction timeouts.';
        window.setTimeout(() => {
          document.getElementById('copy-page')?.removeAttribute('hidden');
        }, 1200);
        document.getElementById('copy-page')?.addEventListener('click', async () => {
          await navigator.clipboard.writeText(markdown);
        });
      `,
    ),
    '/auth/start': htmlRoute(
      'Authenticated Start',
      `
        <article>
          <h1>Private Docs Start</h1>
          <p>Secret market structure docs for authenticated sources.</p>
        </article>
      `,
    ),
  };
}

export async function startDocsServer(): Promise<RunningServer> {
  const routes = createRoutes();
  const requestCounts = new Map<string, number>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/__counts') {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({
        path: url.searchParams.get('path'),
        count: requestCounts.get(url.searchParams.get('path') ?? '') ?? 0,
      }));
      return;
    }

    const currentCount = (requestCounts.get(url.pathname) ?? 0) + 1;
    requestCounts.set(url.pathname, currentCount);

    if (url.pathname === '/auth/start') {
      const headerToken = request.headers['x-aiocs-token'];
      const cookieHeader = request.headers.cookie ?? '';
      const hasSessionCookie = cookieHeader.includes('aiocs_session=cookie-secret');

      if (headerToken !== 'header-secret' || !hasSessionCookie) {
        sendRoute(response, routeWithStatus(
          401,
          htmlRoute(
            'Unauthorized',
            `
              <main>
                <h1>Unauthorized</h1>
                <p>Authenticated request missing required headers or cookies.</p>
              </main>
            `,
          ),
        ));
        return;
      }
    }

    if (url.pathname === '/selector-flaky/start' && currentCount < 3) {
      sendRoute(response, routeWithStatus(
        503,
        htmlRoute(
          'Selector Flaky Temporary Failure',
          `
            <main>
              <h1>Temporary failure</h1>
              <p>Retry should recover this route.</p>
            </main>
          `,
        ),
      ));
      return;
    }

    if (url.pathname === '/selector-always-fail/start') {
      sendRoute(response, routeWithStatus(
        503,
        htmlRoute(
          'Selector Always Fail Temporary Failure',
          `
            <main>
              <h1>Temporary failure</h1>
              <p>This route keeps failing.</p>
            </main>
          `,
        ),
      ));
      return;
    }

    const route = routes[url.pathname];

    if (!route) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }

    sendRoute(response, route);
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

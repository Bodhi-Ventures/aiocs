function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

export function patternToRegex(pattern: string): RegExp {
  let regex = '^';

  for (let index = 0; index < pattern.length; index += 1) {
    const current = pattern[index];
    const next = pattern[index + 1];

    if (current === '*' && next === '*') {
      regex += '.*';
      index += 1;
      continue;
    }

    if (current === '*') {
      regex += '[^?#]*';
      continue;
    }

    regex += escapeRegex(current ?? '');
  }

  return new RegExp(`${regex}$`);
}

export function matchesPatterns(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => patternToRegex(pattern).test(url));
}

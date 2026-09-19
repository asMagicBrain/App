// Package on the actual target host; never reinterpret a foreign binary as a
// qualified native runtime. Each packager enforces its supported architecture.
if (process.platform === 'linux') await import('./package-linux.mjs');
else if (process.platform === 'darwin') await import('./package.mjs');
else throw Error('Native packaging supports macOS arm64 and Ubuntu 24.04 x64.');

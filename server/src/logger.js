'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let threshold = LEVELS.info;

const setLevel = (level) => {
  threshold = LEVELS[level] ?? LEVELS.info;
};

const emit = (level, stream, args) => {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString();
  stream(`${stamp} ${level.toUpperCase().padEnd(5)}`, ...args);
};

module.exports = {
  setLevel,
  debug: (...args) => emit('debug', console.log, args),
  info: (...args) => emit('info', console.log, args),
  warn: (...args) => emit('warn', console.warn, args),
  error: (...args) => emit('error', console.error, args),
};

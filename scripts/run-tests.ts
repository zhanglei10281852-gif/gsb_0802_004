import { findTestFiles } from './find-tests.js';

const files = findTestFiles(['src', 'test']);
const { run } = await import('node:test');
const { spec } = await import('node:test/reporters');

run({ files, concurrency: 1, timeout: 30000 })
  .on('test:fail', () => {
    process.exitCode = 1;
  })
  .compose(new spec())
  .pipe(process.stdout);

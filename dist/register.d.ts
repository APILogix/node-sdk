/**
 * Process bootstrap entrypoint for Node's `--import` preload path.
 *
 * This intentionally shares the same bootstrap implementation and global
 * guards as the root package import. It installs privacy-safe module-load
 * hooks early, but does not initialize transport or read an API key.
 */
export {};

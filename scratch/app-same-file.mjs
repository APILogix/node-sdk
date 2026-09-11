import './preload.mjs';
import pg from 'pg';
const Client = pg.default ? pg.default.Client : pg.Client;
console.log('Same-file static import isWrapped:', !!Client.prototype.query.__wrapped);

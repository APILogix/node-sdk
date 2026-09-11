import pg from 'pg';
const Client = pg.default ? pg.default.Client : pg.Client;
console.log('Static import Client.prototype.query isWrapped:', !!Client.prototype.query.__wrapped);

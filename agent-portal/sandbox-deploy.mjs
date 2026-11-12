import {prepare} from './live-access.mjs';
const root=prepare();process.env.HOST='0.0.0.0';process.env.NODE_ENV='production';
await import('file://'+root+'/server.mjs').then(m=>m.start());

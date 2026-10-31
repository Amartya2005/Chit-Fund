import { env } from './config/env.js';
import app from './app.js';

app.listen(env.port, () => {
  console.log(`=======================================================`);
  console.log(` ChitKart Platform Backend Server (${env.nodeEnv})`);
  console.log(` Running on port: http://localhost:${env.port}`);
  console.log(` API Endpoint: http://localhost:${env.port}/api/v1/health`);
  console.log(`=======================================================`);
});

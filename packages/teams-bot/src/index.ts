import { app } from './server.js';

const port = parseInt(process.env['PORT'] ?? '3978', 10);
app.listen(port, () => {
  console.log(`Teams Bot listening on port ${port}`);
});

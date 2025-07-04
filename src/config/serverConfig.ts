import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../../../.env') });

export const serverConfig = {
  port: Number(process.env.PORT) || 3000,
  corsOrigins: [
    process.env.FRONTEND_URL || 'https://projectnexus-staging.up.railway.app',
    'http://localhost:5173'
  ],
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/projectNexus',
};
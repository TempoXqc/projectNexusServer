import dotenv from 'dotenv';

export const serverConfig = {
  port: Number(process.env.PORT) || 3000,
  corsOrigins: [
    process.env.FRONTEND_URL || 'http://localhost:4173'
  ],
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/projectNexus',
};
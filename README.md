# Secure API Key Rotation Proxy

This project implements a secure, server-side API key rotation proxy using Node.js and Express. It's designed for deployment on Vercel and uses Supabase (PostgreSQL) for storing usage metrics.

## Features

- **API Key Rotation**: Manages a pool of API keys with daily usage limits.
- **Demo Mode**: Provides limited access for users based on a device ID.
- **Security**: Encrypts keys with AES-256-CBC and validates requests with HMAC-SHA256.
- **Serverless**: Built for Vercel with a cron job for daily metric resets.

## Project Structure

```
/
├── api/
│   └── index.js        # Main Express application
├── package.json        # Project dependencies
├── vercel.json         # Vercel deployment configuration (routes, cron)
├── setup.sql           # SQL script for Supabase table creation
├── .env.example        # Template for environment variables
└── README.md           # This file
```

## Setup and Deployment

Follow these steps to get the proxy running.

### 1. Set Up Supabase

1.  **Create a Supabase Project**: Go to [supabase.com](https://supabase.com), create a new project, and save your project URL and `anon` key.
2.  **Create Tables**: In your Supabase project dashboard, navigate to the **SQL Editor**.
3.  **Run SQL Script**: Copy the contents of `setup.sql` and run it to create the `key_usage` and `demo_usage` tables.

### 2. Configure Environment Variables

1.  **Create `.env.local`**: For local testing, create a file named `.env.local` in the project root. **Do not commit this file to Git.**
2.  **Copy from Example**: Copy the contents from `.env.example` into your new `.env.local` file.
3.  **Fill in Values**:
    *   `SUPABASE_URL`: Your Supabase project URL.
    *   `SUPABASE_KEY`: Your Supabase project `anon` key.
    *   `PSK`: A **32-byte (256-bit)** secret key for encryption. You can generate one using a password manager or a command-line tool like `openssl rand -base64 32`.
    *   `API_KEYS`: A JSON array of the API keys you want to rotate (e.g., `'["key1","key2"]'`).
    *   `CRON_SECRET`: A secret string to protect the `/api/reset-metrics` endpoint. Make it long and random.

### 3. Local Development

1.  **Install Dependencies**:
    ```bash
    npm install
    ```
2.  **Start the Server**:
    ```bash
    npm start
    ```
    The server will be running at `http://localhost:3000` (or the port specified in `api/index.js` if you change it).

### 4. Deploy to Vercel

1.  **Push to GitHub**: Create a new repository on GitHub and push your project code.
2.  **Import to Vercel**: Log in to your Vercel account and import the GitHub repository.
3.  **Configure Environment Variables**: In the Vercel project settings, navigate to **Settings > Environment Variables**. Add all the variables from your `.env.local` file.
4.  **Deploy**: Vercel will automatically build and deploy the project. The `vercel.json` file configures the serverless function and the cron job.

### 5. Configure the Vercel Cron Job

The cron job defined in `vercel.json` will call `/api/reset-metrics` daily at midnight UTC. To protect this endpoint, you need to add the `CRON_SECRET` to the request headers.

Since Vercel Cron UI doesn't directly support adding headers, a common workaround is to use a tool like `curl` within the cron command if Vercel allows it, or more simply, ensure the secret is checked from the request as implemented in `api/index.js`. The current implementation expects the secret in the `x-cron-secret` header. You may need to use a service like [EasyCron](https://www.easycron.com/) or a GitHub Action to call your endpoint with the correct header if Vercel's native cron jobs don't support custom headers.

**Note**: The provided `vercel.json` sets up the schedule. Ensure your `CRON_SECRET` is set in Vercel's environment variables. The client calling the cron job must include this secret in the `x-cron-secret` header.

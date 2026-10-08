# Use Node.js 20 Docker image as base
FROM node:20

ENV DATABASE_URI=
# Either 'mongodb', 'postgres', 'mssql' or 'mysql'. This defaults to Postgres
ENV DATABASE_TYPE=
ENV PORT=

# Set the working directory inside the container

RUN npm install -g pnpm@9

WORKDIR /app

# Copy the package.json and pnpm-lock.yaml files to the container
COPY package*.json ./
COPY pnpm-lock*.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy the rest of the demo launcher code to the container
COPY / ./

# Command to run the application
CMD ["pnpm", "start"]
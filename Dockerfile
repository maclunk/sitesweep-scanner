# Use official Playwright image with Chromium
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application files
COPY server.js ./

# Expose port
EXPOSE 8080

# Set environment variable for port
ENV PORT=8080

# Run the server
CMD ["node", "server.js"]


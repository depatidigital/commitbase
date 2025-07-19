FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Build the application if build command exists
{{#if buildCommand}}
RUN {{buildCommand}}
{{/if}}

# Expose port
EXPOSE {{port}}

# Start the application
CMD ["sh","-c","{{startCommand}}"] 
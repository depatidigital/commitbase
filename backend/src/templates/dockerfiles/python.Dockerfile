FROM python:3.11-slim

WORKDIR /app

# Copy requirements file
COPY requirements.txt .

# Install dependencies
RUN pip install -r requirements.txt

# Copy source code
COPY . .

# Expose port
EXPOSE {{port}}

# Start the application
CMD ["{{startCommand}}"] 
FROM rust:1.70-alpine AS builder

WORKDIR /app

# Copy Cargo files
COPY Cargo.toml Cargo.lock ./

# Download dependencies
RUN cargo fetch

# Copy source code
COPY . .

# Build the application
RUN cargo build --release

# Final stage
FROM alpine:latest

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/target/release/* /app/

EXPOSE {{port}}

CMD ["./app"] 
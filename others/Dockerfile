# Use Node 18 (LTS)
FROM node:18-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl unzip git wget golang-go snapd bash \
    && rm -rf /var/lib/apt/lists/*

# Install Subfinder
RUN go install -v github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest \
    && cp /root/go/bin/subfinder /usr/local/bin/

# Install Httpx
RUN go install -v github.com/projectdiscovery/httpx/cmd/httpx@latest \
    && cp /root/go/bin/httpx /usr/local/bin/

# Install Amass
RUN wget https://github.com/owasp-amass/amass/releases/latest/download/amass_linux_amd64.zip \
    && unzip amass_linux_amd64.zip \
    && mv amass_linux_amd64/amass /usr/local/bin/ \
    && rm -rf amass_linux_amd64*

# Set workdir
WORKDIR /app

# Copy package.json and install Node deps
COPY package*.json ./
RUN npm install --production

# Copy the rest of the code
COPY . .

# Expose app port
EXPOSE 3000

# Start the server
CMD ["npm", "start"]

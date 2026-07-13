FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    python3-pip \
    python3-venv \
    python3-full \
    python3-yaml \
    curl \
    unzip \
    default-mysql-client \
    rsync \
    && rm -rf /var/lib/apt/lists/*

# Create and activate a Python virtual environment
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

USER node

# Install Node package managers
RUN npm install -g yarn \
    && npm install -g hardhat bun \
    && curl -fsSL https://bun.sh/install | bash

# Set up custom prompt
RUN echo 'alias nh="npx hardhat"' >> /home/node/.bashrc
RUN echo 'alias nhc="clear && npx hardhat compile"' >> /home/node/.bashrc
RUN echo 'alias nht="clear && npx hardhat test"' >> /home/node/.bashrc
RUN echo 'alias c="clear"' >> /home/node/.bashrc

WORKDIR /workspaces/pod-ecosystem-integration

FROM tensorflow/tensorflow:latest-gpu

RUN apt-get update && apt-get install -y --no-install-recommends \
        mesa-common-dev \
        libxi-dev \
        python-is-python3 \
        libasound2 \
        curl \
        pkg-config \
        git \
        && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN curl -sL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs

WORKDIR /app

COPY /node-server /app

RUN npm install

EXPOSE 9090
CMD ["node", "server.js"]

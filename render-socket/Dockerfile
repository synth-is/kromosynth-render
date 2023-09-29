FROM tensorflow/tensorflow:latest-gpu
#FROM nvidia/cuda:11.6.2-base-ubuntu20.04

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

# https://github.com/cypress-io/cypress-docker-images/issues/52#issuecomment-446144630
COPY /node-server/asound.conf /etc/asound.conf

WORKDIR /app

COPY /node-server /app

RUN npm install
# RUN rm -fr node_modules/node-web-audio-api
# RUN npm install node-web-audio-api@0.7.0

EXPOSE 9090
CMD ["node", "server.js"]

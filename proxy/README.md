# Notes on grpc-web 

`Dockerfile` and `envoy.yaml` are from https://github.com/grpc/grpc-web

## client stub generation

```
sudo mv ~/Downloads/protoc-gen-grpc-web-1.4.2-darwin-aarch64 /usr/local/bin/protoc-gen-grpc-web

sudo chmod +x /usr/local/bin/protoc-gen-grpc-web

sudo  npm install -g protoc-gen-js

protoc -I=. genome-rendering.proto --js_out=import_style=commonjs:. --grpc-web_out=import_style=commonjs,mode=grpcwebtext:.
```
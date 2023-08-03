# kromosynth render

gRPC rendering server, accepting URLs to genomes and returning a rendered sound.


docker build -t grpcweb/envoy -f envoy/Dockerfile ./envoy
docker run -d -p 8080:8080  grpcweb/envoy   
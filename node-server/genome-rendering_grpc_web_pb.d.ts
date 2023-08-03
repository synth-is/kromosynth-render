import * as grpcWeb from 'grpc-web';

import * as node$server_genome$rendering_pb from '../node-server/genome-rendering_pb';


export class KromosynthRenderingClient {
  constructor (hostname: string,
               credentials?: null | { [index: string]: string; },
               options?: null | { [index: string]: any; });

  renderGenome(
    request: node$server_genome$rendering_pb.RenderRequest,
    metadata?: grpcWeb.Metadata
  ): grpcWeb.ClientReadableStream<node$server_genome$rendering_pb.RenderResponse>;

}

export class KromosynthRenderingPromiseClient {
  constructor (hostname: string,
               credentials?: null | { [index: string]: string; },
               options?: null | { [index: string]: any; });

  renderGenome(
    request: node$server_genome$rendering_pb.RenderRequest,
    metadata?: grpcWeb.Metadata
  ): grpcWeb.ClientReadableStream<node$server_genome$rendering_pb.RenderResponse>;

}


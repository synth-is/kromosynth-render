import * as jspb from 'google-protobuf'

import * as google_protobuf_struct_pb from 'google-protobuf/google/protobuf/struct_pb';


export class RenderRequest extends jspb.Message {
  getGenomestringurl(): string;
  setGenomestringurl(value: string): RenderRequest;

  getDuration(): number;
  setDuration(value: number): RenderRequest;

  getNotedelta(): number;
  setNotedelta(value: number): RenderRequest;

  getVelocity(): number;
  setVelocity(value: number): RenderRequest;

  getReverse(): boolean;
  setReverse(value: boolean): RenderRequest;

  getUseovertoneinharmonicityfactors(): boolean;
  setUseovertoneinharmonicityfactors(value: boolean): RenderRequest;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): RenderRequest.AsObject;
  static toObject(includeInstance: boolean, msg: RenderRequest): RenderRequest.AsObject;
  static serializeBinaryToWriter(message: RenderRequest, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): RenderRequest;
  static deserializeBinaryFromReader(message: RenderRequest, reader: jspb.BinaryReader): RenderRequest;
}

export namespace RenderRequest {
  export type AsObject = {
    genomestringurl: string,
    duration: number,
    notedelta: number,
    velocity: number,
    reverse: boolean,
    useovertoneinharmonicityfactors: boolean,
  }
}

export class RenderResponse extends jspb.Message {
  getAudio(): Uint8Array | string;
  getAudio_asU8(): Uint8Array;
  getAudio_asB64(): string;
  setAudio(value: Uint8Array | string): RenderResponse;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): RenderResponse.AsObject;
  static toObject(includeInstance: boolean, msg: RenderResponse): RenderResponse.AsObject;
  static serializeBinaryToWriter(message: RenderResponse, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): RenderResponse;
  static deserializeBinaryFromReader(message: RenderResponse, reader: jspb.BinaryReader): RenderResponse;
}

export namespace RenderResponse {
  export type AsObject = {
    audio: Uint8Array | string,
  }
}


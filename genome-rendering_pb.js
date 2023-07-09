// source: genome-rendering.proto
/**
 * @fileoverview
 * @enhanceable
 * @suppress {missingRequire} reports error on implicit type usages.
 * @suppress {messageConventions} JS Compiler reports an error if a variable or
 *     field starts with 'MSG_' and isn't a translatable message.
 * @public
 */
// GENERATED CODE -- DO NOT EDIT!
/* eslint-disable */
// @ts-nocheck

var jspb = require('google-protobuf');
var goog = jspb;
var global =
    (typeof globalThis !== 'undefined' && globalThis) ||
    (typeof window !== 'undefined' && window) ||
    (typeof global !== 'undefined' && global) ||
    (typeof self !== 'undefined' && self) ||
    (function () { return this; }).call(null) ||
    Function('return this')();

var google_protobuf_struct_pb = require('google-protobuf/google/protobuf/struct_pb.js');
goog.object.extend(proto, google_protobuf_struct_pb);
goog.exportSymbol('proto.kromosynthrendering.RenderRequest', null, global);
goog.exportSymbol('proto.kromosynthrendering.RenderResponse', null, global);
/**
 * Generated by JsPbCodeGenerator.
 * @param {Array=} opt_data Optional initial data array, typically from a
 * server response, or constructed directly in Javascript. The array is used
 * in place and becomes part of the constructed object. It is not cloned.
 * If no data is provided, the constructed object will be empty, but still
 * valid.
 * @extends {jspb.Message}
 * @constructor
 */
proto.kromosynthrendering.RenderRequest = function(opt_data) {
  jspb.Message.initialize(this, opt_data, 0, -1, null, null);
};
goog.inherits(proto.kromosynthrendering.RenderRequest, jspb.Message);
if (goog.DEBUG && !COMPILED) {
  /**
   * @public
   * @override
   */
  proto.kromosynthrendering.RenderRequest.displayName = 'proto.kromosynthrendering.RenderRequest';
}
/**
 * Generated by JsPbCodeGenerator.
 * @param {Array=} opt_data Optional initial data array, typically from a
 * server response, or constructed directly in Javascript. The array is used
 * in place and becomes part of the constructed object. It is not cloned.
 * If no data is provided, the constructed object will be empty, but still
 * valid.
 * @extends {jspb.Message}
 * @constructor
 */
proto.kromosynthrendering.RenderResponse = function(opt_data) {
  jspb.Message.initialize(this, opt_data, 0, -1, null, null);
};
goog.inherits(proto.kromosynthrendering.RenderResponse, jspb.Message);
if (goog.DEBUG && !COMPILED) {
  /**
   * @public
   * @override
   */
  proto.kromosynthrendering.RenderResponse.displayName = 'proto.kromosynthrendering.RenderResponse';
}



if (jspb.Message.GENERATE_TO_OBJECT) {
/**
 * Creates an object representation of this proto.
 * Field names that are reserved in JavaScript and will be renamed to pb_name.
 * Optional fields that are not set will be set to undefined.
 * To access a reserved field use, foo.pb_<name>, eg, foo.pb_default.
 * For the list of reserved names please see:
 *     net/proto2/compiler/js/internal/generator.cc#kKeyword.
 * @param {boolean=} opt_includeInstance Deprecated. whether to include the
 *     JSPB instance for transitional soy proto support:
 *     http://goto/soy-param-migration
 * @return {!Object}
 */
proto.kromosynthrendering.RenderRequest.prototype.toObject = function(opt_includeInstance) {
  return proto.kromosynthrendering.RenderRequest.toObject(opt_includeInstance, this);
};


/**
 * Static version of the {@see toObject} method.
 * @param {boolean|undefined} includeInstance Deprecated. Whether to include
 *     the JSPB instance for transitional soy proto support:
 *     http://goto/soy-param-migration
 * @param {!proto.kromosynthrendering.RenderRequest} msg The msg instance to transform.
 * @return {!Object}
 * @suppress {unusedLocalVariables} f is only used for nested messages
 */
proto.kromosynthrendering.RenderRequest.toObject = function(includeInstance, msg) {
  var f, obj = {
    genomestringurl: jspb.Message.getFieldWithDefault(msg, 1, ""),
    duration: jspb.Message.getFloatingPointFieldWithDefault(msg, 2, 0.0),
    notedelta: jspb.Message.getFloatingPointFieldWithDefault(msg, 3, 0.0),
    velocity: jspb.Message.getFloatingPointFieldWithDefault(msg, 4, 0.0),
    reverse: jspb.Message.getBooleanFieldWithDefault(msg, 5, false),
    useovertoneinharmonicityfactors: jspb.Message.getBooleanFieldWithDefault(msg, 6, false)
  };

  if (includeInstance) {
    obj.$jspbMessageInstance = msg;
  }
  return obj;
};
}


/**
 * Deserializes binary data (in protobuf wire format).
 * @param {jspb.ByteSource} bytes The bytes to deserialize.
 * @return {!proto.kromosynthrendering.RenderRequest}
 */
proto.kromosynthrendering.RenderRequest.deserializeBinary = function(bytes) {
  var reader = new jspb.BinaryReader(bytes);
  var msg = new proto.kromosynthrendering.RenderRequest;
  return proto.kromosynthrendering.RenderRequest.deserializeBinaryFromReader(msg, reader);
};


/**
 * Deserializes binary data (in protobuf wire format) from the
 * given reader into the given message object.
 * @param {!proto.kromosynthrendering.RenderRequest} msg The message object to deserialize into.
 * @param {!jspb.BinaryReader} reader The BinaryReader to use.
 * @return {!proto.kromosynthrendering.RenderRequest}
 */
proto.kromosynthrendering.RenderRequest.deserializeBinaryFromReader = function(msg, reader) {
  while (reader.nextField()) {
    if (reader.isEndGroup()) {
      break;
    }
    var field = reader.getFieldNumber();
    switch (field) {
    case 1:
      var value = /** @type {string} */ (reader.readString());
      msg.setGenomestringurl(value);
      break;
    case 2:
      var value = /** @type {number} */ (reader.readFloat());
      msg.setDuration(value);
      break;
    case 3:
      var value = /** @type {number} */ (reader.readFloat());
      msg.setNotedelta(value);
      break;
    case 4:
      var value = /** @type {number} */ (reader.readFloat());
      msg.setVelocity(value);
      break;
    case 5:
      var value = /** @type {boolean} */ (reader.readBool());
      msg.setReverse(value);
      break;
    case 6:
      var value = /** @type {boolean} */ (reader.readBool());
      msg.setUseovertoneinharmonicityfactors(value);
      break;
    default:
      reader.skipField();
      break;
    }
  }
  return msg;
};


/**
 * Serializes the message to binary data (in protobuf wire format).
 * @return {!Uint8Array}
 */
proto.kromosynthrendering.RenderRequest.prototype.serializeBinary = function() {
  var writer = new jspb.BinaryWriter();
  proto.kromosynthrendering.RenderRequest.serializeBinaryToWriter(this, writer);
  return writer.getResultBuffer();
};


/**
 * Serializes the given message to binary data (in protobuf wire
 * format), writing to the given BinaryWriter.
 * @param {!proto.kromosynthrendering.RenderRequest} message
 * @param {!jspb.BinaryWriter} writer
 * @suppress {unusedLocalVariables} f is only used for nested messages
 */
proto.kromosynthrendering.RenderRequest.serializeBinaryToWriter = function(message, writer) {
  var f = undefined;
  f = message.getGenomestringurl();
  if (f.length > 0) {
    writer.writeString(
      1,
      f
    );
  }
  f = message.getDuration();
  if (f !== 0.0) {
    writer.writeFloat(
      2,
      f
    );
  }
  f = message.getNotedelta();
  if (f !== 0.0) {
    writer.writeFloat(
      3,
      f
    );
  }
  f = message.getVelocity();
  if (f !== 0.0) {
    writer.writeFloat(
      4,
      f
    );
  }
  f = message.getReverse();
  if (f) {
    writer.writeBool(
      5,
      f
    );
  }
  f = message.getUseovertoneinharmonicityfactors();
  if (f) {
    writer.writeBool(
      6,
      f
    );
  }
};


/**
 * optional string genomeStringUrl = 1;
 * @return {string}
 */
proto.kromosynthrendering.RenderRequest.prototype.getGenomestringurl = function() {
  return /** @type {string} */ (jspb.Message.getFieldWithDefault(this, 1, ""));
};


/**
 * @param {string} value
 * @return {!proto.kromosynthrendering.RenderRequest} returns this
 */
proto.kromosynthrendering.RenderRequest.prototype.setGenomestringurl = function(value) {
  return jspb.Message.setProto3StringField(this, 1, value);
};


/**
 * optional float duration = 2;
 * @return {number}
 */
proto.kromosynthrendering.RenderRequest.prototype.getDuration = function() {
  return /** @type {number} */ (jspb.Message.getFloatingPointFieldWithDefault(this, 2, 0.0));
};


/**
 * @param {number} value
 * @return {!proto.kromosynthrendering.RenderRequest} returns this
 */
proto.kromosynthrendering.RenderRequest.prototype.setDuration = function(value) {
  return jspb.Message.setProto3FloatField(this, 2, value);
};


/**
 * optional float noteDelta = 3;
 * @return {number}
 */
proto.kromosynthrendering.RenderRequest.prototype.getNotedelta = function() {
  return /** @type {number} */ (jspb.Message.getFloatingPointFieldWithDefault(this, 3, 0.0));
};


/**
 * @param {number} value
 * @return {!proto.kromosynthrendering.RenderRequest} returns this
 */
proto.kromosynthrendering.RenderRequest.prototype.setNotedelta = function(value) {
  return jspb.Message.setProto3FloatField(this, 3, value);
};


/**
 * optional float velocity = 4;
 * @return {number}
 */
proto.kromosynthrendering.RenderRequest.prototype.getVelocity = function() {
  return /** @type {number} */ (jspb.Message.getFloatingPointFieldWithDefault(this, 4, 0.0));
};


/**
 * @param {number} value
 * @return {!proto.kromosynthrendering.RenderRequest} returns this
 */
proto.kromosynthrendering.RenderRequest.prototype.setVelocity = function(value) {
  return jspb.Message.setProto3FloatField(this, 4, value);
};


/**
 * optional bool reverse = 5;
 * @return {boolean}
 */
proto.kromosynthrendering.RenderRequest.prototype.getReverse = function() {
  return /** @type {boolean} */ (jspb.Message.getBooleanFieldWithDefault(this, 5, false));
};


/**
 * @param {boolean} value
 * @return {!proto.kromosynthrendering.RenderRequest} returns this
 */
proto.kromosynthrendering.RenderRequest.prototype.setReverse = function(value) {
  return jspb.Message.setProto3BooleanField(this, 5, value);
};


/**
 * optional bool useOvertoneInharmonicityFactors = 6;
 * @return {boolean}
 */
proto.kromosynthrendering.RenderRequest.prototype.getUseovertoneinharmonicityfactors = function() {
  return /** @type {boolean} */ (jspb.Message.getBooleanFieldWithDefault(this, 6, false));
};


/**
 * @param {boolean} value
 * @return {!proto.kromosynthrendering.RenderRequest} returns this
 */
proto.kromosynthrendering.RenderRequest.prototype.setUseovertoneinharmonicityfactors = function(value) {
  return jspb.Message.setProto3BooleanField(this, 6, value);
};





if (jspb.Message.GENERATE_TO_OBJECT) {
/**
 * Creates an object representation of this proto.
 * Field names that are reserved in JavaScript and will be renamed to pb_name.
 * Optional fields that are not set will be set to undefined.
 * To access a reserved field use, foo.pb_<name>, eg, foo.pb_default.
 * For the list of reserved names please see:
 *     net/proto2/compiler/js/internal/generator.cc#kKeyword.
 * @param {boolean=} opt_includeInstance Deprecated. whether to include the
 *     JSPB instance for transitional soy proto support:
 *     http://goto/soy-param-migration
 * @return {!Object}
 */
proto.kromosynthrendering.RenderResponse.prototype.toObject = function(opt_includeInstance) {
  return proto.kromosynthrendering.RenderResponse.toObject(opt_includeInstance, this);
};


/**
 * Static version of the {@see toObject} method.
 * @param {boolean|undefined} includeInstance Deprecated. Whether to include
 *     the JSPB instance for transitional soy proto support:
 *     http://goto/soy-param-migration
 * @param {!proto.kromosynthrendering.RenderResponse} msg The msg instance to transform.
 * @return {!Object}
 * @suppress {unusedLocalVariables} f is only used for nested messages
 */
proto.kromosynthrendering.RenderResponse.toObject = function(includeInstance, msg) {
  var f, obj = {
    audio: msg.getAudio_asB64()
  };

  if (includeInstance) {
    obj.$jspbMessageInstance = msg;
  }
  return obj;
};
}


/**
 * Deserializes binary data (in protobuf wire format).
 * @param {jspb.ByteSource} bytes The bytes to deserialize.
 * @return {!proto.kromosynthrendering.RenderResponse}
 */
proto.kromosynthrendering.RenderResponse.deserializeBinary = function(bytes) {
  var reader = new jspb.BinaryReader(bytes);
  var msg = new proto.kromosynthrendering.RenderResponse;
  return proto.kromosynthrendering.RenderResponse.deserializeBinaryFromReader(msg, reader);
};


/**
 * Deserializes binary data (in protobuf wire format) from the
 * given reader into the given message object.
 * @param {!proto.kromosynthrendering.RenderResponse} msg The message object to deserialize into.
 * @param {!jspb.BinaryReader} reader The BinaryReader to use.
 * @return {!proto.kromosynthrendering.RenderResponse}
 */
proto.kromosynthrendering.RenderResponse.deserializeBinaryFromReader = function(msg, reader) {
  while (reader.nextField()) {
    if (reader.isEndGroup()) {
      break;
    }
    var field = reader.getFieldNumber();
    switch (field) {
    case 1:
      var value = /** @type {!Uint8Array} */ (reader.readBytes());
      msg.setAudio(value);
      break;
    default:
      reader.skipField();
      break;
    }
  }
  return msg;
};


/**
 * Serializes the message to binary data (in protobuf wire format).
 * @return {!Uint8Array}
 */
proto.kromosynthrendering.RenderResponse.prototype.serializeBinary = function() {
  var writer = new jspb.BinaryWriter();
  proto.kromosynthrendering.RenderResponse.serializeBinaryToWriter(this, writer);
  return writer.getResultBuffer();
};


/**
 * Serializes the given message to binary data (in protobuf wire
 * format), writing to the given BinaryWriter.
 * @param {!proto.kromosynthrendering.RenderResponse} message
 * @param {!jspb.BinaryWriter} writer
 * @suppress {unusedLocalVariables} f is only used for nested messages
 */
proto.kromosynthrendering.RenderResponse.serializeBinaryToWriter = function(message, writer) {
  var f = undefined;
  f = message.getAudio_asU8();
  if (f.length > 0) {
    writer.writeBytes(
      1,
      f
    );
  }
};


/**
 * optional bytes audio = 1;
 * @return {string}
 */
proto.kromosynthrendering.RenderResponse.prototype.getAudio = function() {
  return /** @type {string} */ (jspb.Message.getFieldWithDefault(this, 1, ""));
};


/**
 * optional bytes audio = 1;
 * This is a type-conversion wrapper around `getAudio()`
 * @return {string}
 */
proto.kromosynthrendering.RenderResponse.prototype.getAudio_asB64 = function() {
  return /** @type {string} */ (jspb.Message.bytesAsB64(
      this.getAudio()));
};


/**
 * optional bytes audio = 1;
 * Note that Uint8Array is not supported on all browsers.
 * @see http://caniuse.com/Uint8Array
 * This is a type-conversion wrapper around `getAudio()`
 * @return {!Uint8Array}
 */
proto.kromosynthrendering.RenderResponse.prototype.getAudio_asU8 = function() {
  return /** @type {!Uint8Array} */ (jspb.Message.bytesAsU8(
      this.getAudio()));
};


/**
 * @param {!(string|Uint8Array)} value
 * @return {!proto.kromosynthrendering.RenderResponse} returns this
 */
proto.kromosynthrendering.RenderResponse.prototype.setAudio = function(value) {
  return jspb.Message.setProto3BytesField(this, 1, value);
};


goog.object.extend(exports, proto.kromosynthrendering);

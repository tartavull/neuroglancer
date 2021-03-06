/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {RefCounted} from 'neuroglancer/util/disposable';
import {identityMat4} from 'neuroglancer/util/geom';
import {getObjectId} from 'neuroglancer/util/object_id';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';
import {resizeTexture} from 'neuroglancer/webgl/texture';
import {defineCopyFragmentShader, elementWiseTextureShader} from 'neuroglancer/webgl/trivial_shaders';

export abstract class SizeManaged extends RefCounted {
  width = Number.NaN;
  height = Number.NaN;

  hasSize(width: number, height: number) { return this.width === width && this.height === height; }

  resize(width: number, height: number) {
    if (this.hasSize(width, height)) {
      return;
    }
    this.width = width;
    this.height = height;

    this.performResize();
  }
  protected abstract performResize(): void;
}

export class Renderbuffer extends SizeManaged {
  renderbuffer: WebGLRenderbuffer|null = null;

  constructor(public gl: GL, public internalformat: number) {
    super();
    this.renderbuffer = gl.createRenderbuffer();
  }

  protected performResize() {
    let {gl} = this;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.renderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, this.internalformat, this.width, this.height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  }

  disposed() { this.gl.deleteRenderbuffer(this.renderbuffer); }

  attachToFramebuffer(attachment: number) {
    let {gl} = this;
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, attachment, gl.RENDERBUFFER, this.renderbuffer);
  }
}

export class DepthBuffer extends Renderbuffer {
  constructor(public gl: GL, public includeStencilBuffer = false) {
    super(gl, includeStencilBuffer ? gl.DEPTH_STENCIL : gl.DEPTH_COMPONENT16);
  }
  attachToFramebuffer() {
    let {gl} = this;
    super.attachToFramebuffer(
        this.includeStencilBuffer ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT);
  }
}

export class DepthStencilBuffer extends DepthBuffer {
  constructor(gl: GL) { super(gl, /*includeStencilBuffer=*/true); }
}

export const StencilBuffer = DepthStencilBuffer;

export class Framebuffer extends RefCounted {
  framebuffer = this.gl.createFramebuffer();
  constructor(public gl: GL) { super(); }
  disposed() {
    let {gl} = this;
    gl.deleteFramebuffer(this.framebuffer);
  }
  bind() {
    let {gl} = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
  }
  unbind() {
    let {gl} = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}

export class TextureBuffer extends SizeManaged {
  texture: WebGLTexture|null;

  constructor(public gl: GL, public format: number, public dataType: number) {
    super();
    this.texture = gl.createTexture();
  }

  protected performResize() {
    resizeTexture(this.gl, this.texture, this.width, this.height, this.format, this.dataType);
  }

  disposed() { this.gl.deleteTexture(this.texture); }

  attachToFramebuffer(attachment: number) {
    let {gl} = this;
    gl.framebufferTexture2D(
        gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, this.texture,
        /*level=*/0);
  }
}

export function makeTextureBuffers(
    gl: GL, count: number, format: number = gl.RGBA, dataType: number = gl.UNSIGNED_BYTE) {
  let result = new Array<TextureBuffer>();
  for (let i = 0; i < count; ++i) {
    result[i] = new TextureBuffer(gl, format, dataType);
  }
  return result;
}

const tempPixel = new Uint8Array(4);
export class FramebufferConfiguration<ColorBuffer extends TextureBuffer|Renderbuffer> extends
    RefCounted {
  width = Number.NaN;
  height = Number.NaN;

  colorBuffers: ColorBuffer[];
  framebuffer: Framebuffer;
  depthBuffer: DepthBuffer|undefined;
  private fullAttachmentList = new Array<number>();
  private attachmentVerified = false;
  private singleAttachmentList = [this.gl.COLOR_ATTACHMENT0];

  constructor(public gl: GL, configuration: {
    framebuffer?: Framebuffer,
    colorBuffers: ColorBuffer[], depthBuffer?: DepthBuffer
  }) {
    super();
    let {framebuffer = new Framebuffer(gl), colorBuffers, depthBuffer} = configuration;
    this.framebuffer = this.registerDisposer(framebuffer);
    this.colorBuffers = colorBuffers;
    this.depthBuffer = depthBuffer;
    if (depthBuffer !== undefined) {
      this.registerDisposer(depthBuffer);
    }
    let {fullAttachmentList} = this;
    colorBuffers.forEach((buffer, i) => {
      this.registerDisposer(buffer);
      fullAttachmentList[i] = gl.COLOR_ATTACHMENT0 + i;
    });
  }

  hasSize(width: number, height: number) { return this.width === width && this.height === height; }

  bind(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.framebuffer.bind();
    let {gl, depthBuffer} = this;
    if (depthBuffer !== undefined) {
      depthBuffer.resize(width, height);
      depthBuffer.attachToFramebuffer();
    }
    this.colorBuffers.forEach((buffer, i) => {
      buffer.resize(width, height);
      buffer.attachToFramebuffer(gl.COLOR_ATTACHMENT0 + i);
    });
    gl.WEBGL_draw_buffers.drawBuffersWEBGL(this.fullAttachmentList);
    this.verifyAttachment();
    gl.viewport(0, 0, width, height);
  }

  bindSingle(textureIndex: number) {
    let {gl} = this;
    this.framebuffer.bind();
    this.colorBuffers[textureIndex].attachToFramebuffer(gl.COLOR_ATTACHMENT0);
    gl.WEBGL_draw_buffers.drawBuffersWEBGL(this.singleAttachmentList);
  }

  unbind() { this.framebuffer.unbind(); }

  /**
   * Only supports UNSIGNED_BYTE RGBA textures.
   */
  readPixel(textureIndex: number, glWindowX: number, glWindowY: number): Uint8Array {
    let {gl} = this;
    try {
      this.bindSingle(textureIndex);
      gl.readPixels(glWindowX, glWindowY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, tempPixel);
    } finally {
      this.framebuffer.unbind();
    }
    return tempPixel;
  }

  /**
   * Calls readPixel, but interprets the RGBA result as a little-endian uint32 value.
   */
  readPixelAsUint32(textureIndex: number, glWindowX: number, glWindowY: number) {
    let result = this.readPixel(textureIndex, glWindowX, glWindowY);
    return result[0] + (result[1] << 8) + (result[2] << 16) + (result[3] << 24);
  }

  verifyAttachment() {
    if (this.attachmentVerified) {
      return;
    }
    let {gl} = this;
    let framebufferStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (framebufferStatus !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Framebuffer configuration not supported');
    }
    this.attachmentVerified = true;
  }
}

export class OffscreenCopyHelper extends RefCounted {
  constructor(public gl: GL, public shader: ShaderProgram) {
    super();
    this.registerDisposer(shader);
  }
  private copyVertexPositionsBuffer = this.registerDisposer(Buffer.fromData(
      this.gl, new Float32Array([
        -1, -1, 0, 1,  //
        -1, +1, 0, 1,  //
        +1, +1, 0, 1,  //
        +1, -1, 0, 1,  //
      ]),
      this.gl.ARRAY_BUFFER, this.gl.STATIC_DRAW));
  private copyTexCoordsBuffer = this.registerDisposer(Buffer.fromData(
      this.gl, new Float32Array([
        0, 0,  //
        0, 1,  //
        1, 1,  //
        1, 0,  //
      ]),
      this.gl.ARRAY_BUFFER, this.gl.STATIC_DRAW));

  draw(...textures: (WebGLTexture|null)[]) {
    let {gl, shader} = this;
    shader.bind();

    let numTextures = textures.length;
    for (let i = 0; i < numTextures; ++i) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, textures[i]);
    }

    gl.uniformMatrix4fv(shader.uniform('uProjectionMatrix'), false, identityMat4);

    let aVertexPosition = shader.attribute('aVertexPosition');
    this.copyVertexPositionsBuffer.bindToVertexAttrib(aVertexPosition, 4);

    let aTexCoord = shader.attribute('aTexCoord');
    this.copyTexCoordsBuffer.bindToVertexAttrib(aTexCoord, 2);

    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

    gl.disableVertexAttribArray(aVertexPosition);
    gl.disableVertexAttribArray(aTexCoord);

    for (let i = 0; i < numTextures; ++i) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  static get(
      gl: GL, shaderModule: ShaderModule = defineCopyFragmentShader, numTextures: number = 1) {
    return gl.memoize.get(
        `OffscreenCopyHelper:${numTextures}:${getObjectId(shaderModule)}`,
        () => new OffscreenCopyHelper(gl, elementWiseTextureShader(gl, shaderModule, numTextures)));
  }
};

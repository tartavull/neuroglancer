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

import {DataType, VolumeType} from 'neuroglancer/sliceview/base';
import {Mat4, Vec3} from 'neuroglancer/util/geom';

export const NIFTI_FILE_SOURCE_RPC_ID = 'nifti/NiftiFileSource';
export const GET_NIFTI_VOLUME_INFO_RPC_ID = 'nifti/getNiftiVolumeInfo';

export interface NiftiVolumeInfo {
  numChannels: number;
  dataType: DataType;
  volumeType: VolumeType;
  voxelSize: Vec3;
  affine: Mat4;
  description: string;
  volumeSize: Vec3;
}

export enum NiftiDataType {
  NONE = 0,
  BINARY = 1,
  UINT8 = 2,
  INT16 = 4,
  INT32 = 8,
  FLOAT32 = 16,
  COMPLEX64 = 32,
  FLOAT64 = 64,
  RGB24 = 128,
  INT8 = 256,
  UINT16 = 512,
  UINT32 = 768,
  INT64 = 1024,
  UINT64 = 1280,
  FLOAT128 = 1536,
  COMPLEX128 = 1792,
  COMPLEX256 = 2048,
}

export class VolumeSourceParameters {
  url: string;

  static RPC_ID = 'nifti/VolumeChunkSource';

  static stringify(p: VolumeSourceParameters) { return `nifti:${p.url}`; }
};

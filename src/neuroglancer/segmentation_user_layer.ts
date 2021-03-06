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

import {getMeshSource, getSkeletonSource} from 'neuroglancer/datasource/factory';
import {UserLayer, UserLayerDropdown} from 'neuroglancer/layer';
import {LayerListSpecification} from 'neuroglancer/layer_specification';
import {getVolumeWithStatusMessage} from 'neuroglancer/layer_specification';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {MeshLayer} from 'neuroglancer/mesh/frontend';
import {SegmentColorHash} from 'neuroglancer/segment_color';
import {SegmentationDisplayState, SegmentSelectionState, Uint64MapEntry} from 'neuroglancer/segmentation_display_state/frontend';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {PerspectiveViewSkeletonLayer, SkeletonLayer, SliceViewPanelSkeletonLayer} from 'neuroglancer/skeleton/frontend';
import {SegmentationRenderLayer} from 'neuroglancer/sliceview/segmentation_renderlayer';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {parseArray, verifyObjectProperty, verifyOptionalString} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
import {RangeWidget} from 'neuroglancer/widget/range';
import {SegmentSetWidget} from 'neuroglancer/widget/segment_set_widget';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';

require('./segmentation_user_layer.css');

const SELECTED_ALPHA_JSON_KEY = 'selectedAlpha';
const NOT_SELECTED_ALPHA_JSON_KEY = 'notSelectedAlpha';
const OBJECT_ALPHA_JSON_KEY = 'objectAlpha';


export class SegmentationUserLayer extends UserLayer implements SegmentationDisplayState {
  segmentColorHash = SegmentColorHash.getDefault();
  segmentSelectionState = new SegmentSelectionState();
  selectedAlpha = trackableAlphaValue(0.5);
  notSelectedAlpha = trackableAlphaValue(0);
  objectAlpha = trackableAlphaValue(1.0);
  visibleSegments = Uint64Set.makeWithCounterpart(this.manager.worker);
  segmentEquivalences = SharedDisjointUint64Sets.makeWithCounterpart(this.manager.worker);
  volumePath: string|undefined;
  meshPath: string|undefined;
  skeletonsPath: string|undefined;
  meshLayer: MeshLayer|undefined;

  constructor(public manager: LayerListSpecification, x: any) {
    super([]);
    this.visibleSegments.changed.add(() => { this.specificationChanged.dispatch(); });
    this.segmentEquivalences.changed.add(() => { this.specificationChanged.dispatch(); });
    this.segmentSelectionState.bindTo(manager.layerSelectedValues, this);
    this.selectedAlpha.changed.add(() => { this.specificationChanged.dispatch(); });
    this.notSelectedAlpha.changed.add(() => { this.specificationChanged.dispatch(); });
    this.objectAlpha.changed.add(() => { this.specificationChanged.dispatch(); });

    this.selectedAlpha.restoreState(x[SELECTED_ALPHA_JSON_KEY]);
    this.notSelectedAlpha.restoreState(x[NOT_SELECTED_ALPHA_JSON_KEY]);
    this.objectAlpha.restoreState(x[OBJECT_ALPHA_JSON_KEY]);

    let volumePath = this.volumePath = verifyOptionalString(x['source']);
    let meshPath = this.meshPath = verifyOptionalString(x['mesh']);
    let skeletonsPath = this.skeletonsPath = verifyOptionalString(x['skeletons']);
    if (volumePath !== undefined) {
      getVolumeWithStatusMessage(manager.chunkManager, volumePath).then(volume => {
        if (!this.wasDisposed) {
          this.addRenderLayer(new SegmentationRenderLayer(volume, this));
          if (meshPath === undefined) {
            let meshSource = volume.getMeshSource();
            if (meshSource != null) {
              this.addMesh(meshSource);
            }
          }
        }
      });
    }

    if (meshPath !== undefined) {
      getMeshSource(manager.chunkManager, meshPath).then(meshSource => {
        if (!this.wasDisposed) {
          this.addMesh(meshSource);
        }
      });
    }

    if (skeletonsPath !== undefined) {
      getSkeletonSource(manager.chunkManager, skeletonsPath).then(skeletonSource => {
        if (!this.wasDisposed) {
          let base =
              new SkeletonLayer(manager.chunkManager, skeletonSource, manager.voxelSize, this);
          this.addRenderLayer(new PerspectiveViewSkeletonLayer(base));
          this.addRenderLayer(new SliceViewPanelSkeletonLayer(base));
        }
      });
    }

    verifyObjectProperty(x, 'equivalences', y => { this.segmentEquivalences.restoreState(y); });

    verifyObjectProperty(x, 'segments', y => {
      if (y !== undefined) {
        let {visibleSegments, segmentEquivalences} = this;
        parseArray(y, value => {
          let id = Uint64.parseString(String(value), 10);
          visibleSegments.add(segmentEquivalences.get(id));
        });
      }
    });
  }

  addMesh(meshSource: MeshSource) {
    this.meshLayer = new MeshLayer(this.manager.chunkManager, meshSource, this);
    this.addRenderLayer(this.meshLayer);
  }

  toJSON() {
    let x: any = {'type': 'segmentation'};
    x['source'] = this.volumePath;
    x['mesh'] = this.meshPath;
    x['skeletons'] = this.skeletonsPath;
    x[SELECTED_ALPHA_JSON_KEY] = this.selectedAlpha.toJSON();
    x[NOT_SELECTED_ALPHA_JSON_KEY] = this.notSelectedAlpha.toJSON();
    x[OBJECT_ALPHA_JSON_KEY] = this.objectAlpha.toJSON();
    let {visibleSegments} = this;
    if (visibleSegments.size > 0) {
      x['segments'] = visibleSegments.toJSON();
    }
    let {segmentEquivalences} = this;
    if (segmentEquivalences.size > 0) {
      x['equivalences'] = segmentEquivalences.toJSON();
    }
    return x;
  }

  transformPickedValue(value: any) {
    if (value == null) {
      return value;
    }
    let {segmentEquivalences} = this;
    if (segmentEquivalences.size === 0) {
      return value;
    }
    if (typeof value === 'number') {
      value = new Uint64(value, 0);
    }
    let mappedValue = segmentEquivalences.get(value);
    if (Uint64.equal(mappedValue, value)) {
      return value;
    }
    return new Uint64MapEntry(value, mappedValue);
  }

  makeDropdown(element: HTMLDivElement) { return new SegmentationDropdown(element, this); }

  handleAction(action: string) {
    switch (action) {
      case 'recolor': {
        this.segmentColorHash.randomize();
        break;
      }
      case 'clear-segments': {
        this.visibleSegments.clear();
        break;
      }
      case 'select': {
        let {segmentSelectionState} = this;
        if (segmentSelectionState.hasSelectedSegment) {
          let segment = segmentSelectionState.selectedSegment;
          let {visibleSegments} = this;
          if (visibleSegments.has(segment)) {
            visibleSegments.delete(segment);
          } else {
            visibleSegments.add(segment);
          }
        }
        break;
      }
    }
  }
};

class SegmentationDropdown extends UserLayerDropdown {
  visibleSegmentWidget = this.registerDisposer(new SegmentSetWidget(this.layer));
  addSegmentWidget = this.registerDisposer(new Uint64EntryWidget());
  selectedAlphaWidget = this.registerDisposer(new RangeWidget(this.layer.selectedAlpha));
  notSelectedAlphaWidget = this.registerDisposer(new RangeWidget(this.layer.notSelectedAlpha));
  objectAlphaWidget = this.registerDisposer(new RangeWidget(this.layer.objectAlpha));
  constructor(public element: HTMLDivElement, public layer: SegmentationUserLayer) {
    super();
    element.classList.add('segmentation-dropdown');
    let {selectedAlphaWidget, notSelectedAlphaWidget, objectAlphaWidget} = this;
    selectedAlphaWidget.promptElement.textContent = 'Opacity (on)';
    notSelectedAlphaWidget.promptElement.textContent = 'Opacity (off)';
    objectAlphaWidget.promptElement.textContent = 'Opacity (3d)';

    element.appendChild(this.selectedAlphaWidget.element);
    element.appendChild(this.notSelectedAlphaWidget.element);
    element.appendChild(this.objectAlphaWidget.element);
    this.addSegmentWidget.element.classList.add('add-segment');
    this.addSegmentWidget.element.title = 'Add segment ID';
    element.appendChild(this.registerDisposer(this.addSegmentWidget).element);
    this.registerSignalBinding(this.addSegmentWidget.valueEntered.add(
        (value: Uint64) => { this.layer.visibleSegments.add(value); }));
    element.appendChild(this.registerDisposer(this.visibleSegmentWidget).element);
  }
};

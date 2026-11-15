import { CAUSTIC, MESH, SHADOW, SIM, TERRAIN, wgslConstants } from './config';
import type { Kind, Layouts } from './kind';
import utilCode from './shaders/util.wgsl?raw';
import frameCode from './shaders/frame.wgsl?raw';
import lightingCode from './shaders/lighting.wgsl?raw';
import terrainGenCode from './shaders/terraingen.wgsl?raw';
import simCode from './shaders/sim.wgsl?raw';
import terrainCode from './shaders/terrain.wgsl?raw';
import causticsCode from './shaders/caustics.wgsl?raw';
import waterCode from './shaders/water.wgsl?raw';
import postCode from './shaders/post.wgsl?raw';

export const PRELUDE = wgslConstants() + utilCode;
export const SCENE_PRELUDE = PRELUDE + frameCode + lightingCode;

export const FRAME_FLOATS = 96;
export const SIM_FLOATS = 88;
const BLOOM_LEVELS = 5;

interface Target {
  texture: GPUTexture;
  view: GPUTextureView;
}

export interface SimInput {
  dt: number;
  substeps: number;
  data: Float32Array; // SIM_FLOATS
}

export class Renderer {
  readonly layouts: Layouts;
  readonly frameData = new Float32Array(FRAME_FLOATS);
  readonly simData = new Float32Array(SIM_FLOATS);
  kinds: Kind[] = [];
  width = 1;
  height = 1;

  private frameBuffer: GPUBuffer;
  private simBuffer: GPUBuffer;
  private terrainTexture: Target;
  private surfaceA: Target;
  private surfaceB: Target;
  private caustics: Target;
  private shadowMap: Target;
  private linearSampler: GPUSampler;
  private compareSampler: GPUSampler;
  private frameGroup!: GPUBindGroup;
  private lightingGroup!: GPUBindGroup;
  private emptyGroup: GPUBindGroup;

  private simPipelines: Record<'initMask' | 'force' | 'step' | 'surface', GPUComputePipeline>;
  private simGroups: [GPUBindGroup, GPUBindGroup];
  private simUniformGroup: GPUBindGroup;
  private simCurrent = 0;

  private causticPipelines: GPURenderPipeline[];
  private causticIndex: GPUBuffer;
  private causticCount: number;

  private terrainPipeline: GPURenderPipeline;
  private terrainShadowPipeline: GPURenderPipeline;
  private terrainIndex: GPUBuffer;
  private terrainCount: number;
  private terrainShadowIndex: GPUBuffer;
  private terrainShadowCount: number;

  private waterPipeline: GPURenderPipeline;
  private waterLayout: GPUBindGroupLayout;
  private waterGroup!: GPUBindGroup;

  private postLayout: GPUBindGroupLayout;
  private downPipeline: GPURenderPipeline;
  private upPipeline: GPURenderPipeline;
  private compositePipeline: GPURenderPipeline;
  private postBuffers: GPUBuffer[] = [];
  private postGroups: { down: GPUBindGroup[]; up: GPUBindGroup[]; composite: GPUBindGroup } | null = null;

  private sceneColor!: Target;
  private sceneDist!: Target;
  private depth!: Target;
  private hdr!: Target;
  private bloom: Target[] = [];
  private dummy: Target | null = null;

  heights: Float32Array | null = null;

  constructor(
    readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    format: GPUTextureFormat,
  ) {
    const d = device;
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.frameBuffer = d.createBuffer({ label: 'frame', size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.simBuffer = d.createBuffer({ label: 'sim', size: SIM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const tex = (label: string, size: [number, number], format: GPUTextureFormat, usage: number): Target => {
      const texture = d.createTexture({ label, size, format, usage });
      return { texture, view: texture.createView() };
    };
    const T = GPUTextureUsage;
    this.terrainTexture = tex('terrain', [TERRAIN.size[0], TERRAIN.size[1]], 'rgba16float', T.STORAGE_BINDING | T.TEXTURE_BINDING);
    this.surfaceA = tex('surface a', [SIM.size[0], SIM.size[1]], 'rgba16float', T.STORAGE_BINDING | T.TEXTURE_BINDING);
    this.surfaceB = tex('surface b', [SIM.size[0], SIM.size[1]], 'rgba16float', T.STORAGE_BINDING | T.TEXTURE_BINDING);
    this.caustics = tex('caustics', [CAUSTIC.size[0], CAUSTIC.size[1]], 'rgba16float', T.RENDER_ATTACHMENT | T.TEXTURE_BINDING);
    this.shadowMap = tex('shadow', [SHADOW.size, SHADOW.size], 'depth32float', T.RENDER_ATTACHMENT | T.TEXTURE_BINDING);
    this.linearSampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.compareSampler = d.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });

    this.layouts = {
      frame: d.createBindGroupLayout({
        label: 'frame',
        entries: [
          { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
          { binding: 1, visibility: VF, texture: { sampleType: 'float' } },
          { binding: 2, visibility: VF, texture: { sampleType: 'float' } },
          { binding: 3, visibility: VF, texture: { sampleType: 'float' } },
          { binding: 4, visibility: VF, sampler: { type: 'filtering' } },
        ],
      }),
      lighting: d.createBindGroupLayout({
        label: 'lighting',
        entries: [
          { binding: 0, visibility: VF, texture: { sampleType: 'float' } },
          { binding: 1, visibility: VF, texture: { sampleType: 'depth' } },
          { binding: 2, visibility: VF, sampler: { type: 'comparison' } },
        ],
      }),
      object: d.createBindGroupLayout({
        label: 'object',
        entries: [{ binding: 0, visibility: VF, buffer: { type: 'read-only-storage' } }],
      }),
      empty: d.createBindGroupLayout({ label: 'empty', entries: [] }),
    };
    this.emptyGroup = d.createBindGroup({ layout: this.layouts.empty, entries: [] });
    this.frameGroup = d.createBindGroup({
      label: 'frame',
      layout: this.layouts.frame,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: this.terrainTexture.view },
        { binding: 2, resource: this.surfaceA.view },
        { binding: 3, resource: this.surfaceB.view },
        { binding: 4, resource: this.linearSampler },
      ],
    });
    this.lightingGroup = d.createBindGroup({
      label: 'lighting',
      layout: this.layouts.lighting,
      entries: [
        { binding: 0, resource: this.caustics.view },
        { binding: 1, resource: this.shadowMap.view },
        { binding: 2, resource: this.compareSampler },
      ],
    });

    // Water simulation.
    const simModule = d.createShaderModule({ label: 'sim', code: PRELUDE + simCode });
    const simUniformLayout = d.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }],
    });
    const C = GPUShaderStage.COMPUTE;
    const simStateLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'storage' } },
        { binding: 1, visibility: C, buffer: { type: 'storage' } },
        { binding: 2, visibility: C, buffer: { type: 'storage' } },
        { binding: 3, visibility: C, texture: { sampleType: 'float' } },
        { binding: 4, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
        { binding: 5, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
      ],
    });
    const simLayout = d.createPipelineLayout({ bindGroupLayouts: [simUniformLayout, simStateLayout] });
    const simPipe = (entryPoint: string) => d.createComputePipeline({ label: `sim ${entryPoint}`, layout: simLayout, compute: { module: simModule, entryPoint } });
    this.simPipelines = { initMask: simPipe('initMask'), force: simPipe('force'), step: simPipe('step'), surface: simPipe('surface') };
    const cells = SIM.size[0] * SIM.size[1];
    const stateA = d.createBuffer({ label: 'water a', size: cells * 16, usage: GPUBufferUsage.STORAGE });
    const stateB = d.createBuffer({ label: 'water b', size: cells * 16, usage: GPUBufferUsage.STORAGE });
    const mask = d.createBuffer({ label: 'water mask', size: cells * 4, usage: GPUBufferUsage.STORAGE });
    const simGroup = (a: GPUBuffer, b: GPUBuffer) =>
      d.createBindGroup({
        layout: simStateLayout,
        entries: [
          { binding: 0, resource: { buffer: a } },
          { binding: 1, resource: { buffer: mask } },
          { binding: 2, resource: { buffer: b } },
          { binding: 3, resource: this.terrainTexture.view },
          { binding: 4, resource: this.surfaceA.view },
          { binding: 5, resource: this.surfaceB.view },
        ],
      });
    this.simGroups = [simGroup(stateA, stateB), simGroup(stateB, stateA)];
    this.simUniformGroup = d.createBindGroup({ layout: simUniformLayout, entries: [{ binding: 0, resource: { buffer: this.simBuffer } }] });

    // Caustics.
    const causticModule = d.createShaderModule({ label: 'caustics', code: PRELUDE + frameCode + causticsCode });
    const [cc, cr] = CAUSTIC.grid;
    const causticLayout = d.createPipelineLayout({ bindGroupLayouts: [this.layouts.frame] });
    const channels: [number, number][] = [
      [1.329, GPUColorWrite.RED],
      [1.333, GPUColorWrite.GREEN],
      [1.338, GPUColorWrite.BLUE],
    ];
    this.causticPipelines = channels.map(([ior, writeMask]) =>
      d.createRenderPipeline({
        label: 'caustics',
        layout: causticLayout,
        vertex: { module: causticModule, entryPoint: 'vs', constants: { columns: cc, rows: cr, ior } },
        fragment: {
          module: causticModule,
          entryPoint: 'fs',
          targets: [
            {
              format: 'rgba16float',
              writeMask,
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list' },
      }),
    );
    const grid = (cols: number, rows: number) => {
      const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
      let k = 0;
      for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < cols - 1; c++) {
          const i = r * cols + c;
          idx.set([i, i + cols, i + 1, i + 1, i + cols, i + cols + 1], k);
          k += 6;
        }
      }
      const buffer = d.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(buffer, 0, idx);
      return { buffer, count: idx.length };
    };
    const cg = grid(cc, cr);
    this.causticIndex = cg.buffer;
    this.causticCount = cg.count;

    // Terrain.
    const terrainModule = d.createShaderModule({ label: 'terrain', code: SCENE_PRELUDE + terrainCode });
    const [tc, tr] = MESH.terrain;
    const [sc, sr] = MESH.terrainShadow;
    this.terrainPipeline = d.createRenderPipeline({
      label: 'terrain',
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.layouts.frame, this.layouts.lighting] }),
      vertex: { module: terrainModule, entryPoint: 'vs', constants: { columns: tc, rows: tr } },
      fragment: { module: terrainModule, entryPoint: 'fs', targets: [{ format: 'rgba16float' }, { format: 'r32float' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.terrainShadowPipeline = d.createRenderPipeline({
      label: 'terrain shadow',
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.layouts.frame] }),
      vertex: { module: terrainModule, entryPoint: 'vsShadow', constants: { columns: sc, rows: sr } },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 3, depthBiasSlopeScale: 2.5 },
    });
    const tg = grid(tc, tr);
    this.terrainIndex = tg.buffer;
    this.terrainCount = tg.count;
    const sg = grid(sc, sr);
    this.terrainShadowIndex = sg.buffer;
    this.terrainShadowCount = sg.count;

    // Water surface composite.
    const waterModule = d.createShaderModule({ label: 'water', code: PRELUDE + frameCode + waterCode });
    this.waterLayout = d.createBindGroupLayout({
      label: 'water',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      ],
    });
    this.waterPipeline = d.createRenderPipeline({
      label: 'water',
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.layouts.frame, this.waterLayout] }),
      vertex: { module: waterModule, entryPoint: 'vs' },
      fragment: { module: waterModule, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });

    // Post.
    const postModule = d.createShaderModule({ label: 'post', code: PRELUDE + postCode });
    this.postLayout = d.createBindGroupLayout({
      label: 'post',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    const postPipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [this.postLayout] });
    const postPipe = (entryPoint: string, format: GPUTextureFormat, additive: boolean) =>
      d.createRenderPipeline({
        label: `post ${entryPoint}`,
        layout: postPipelineLayout,
        vertex: { module: postModule, entryPoint: 'vs' },
        fragment: {
          module: postModule,
          entryPoint,
          targets: [
            additive
              ? {
                  format,
                  blend: {
                    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                  },
                }
              : { format },
          ],
        },
        primitive: { topology: 'triangle-list' },
      });
    this.downPipeline = postPipe('down', 'rgba16float', false);
    this.upPipeline = postPipe('up', 'rgba16float', true);
    this.compositePipeline = postPipe('composite', format, false);
    for (let i = 0; i < BLOOM_LEVELS * 2 + 1; i++) {
      this.postBuffers.push(d.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    }
  }

  /** Generate the terrain and read its heights back for the CPU. */
  async buildTerrain() {
    const d = this.device;
    const module = d.createShaderModule({ label: 'terrain gen', code: PRELUDE + terrainGenCode });
    const pipeline = d.createComputePipeline({ label: 'terrain gen', layout: 'auto', compute: { module, entryPoint: 'main' } });
    const count = TERRAIN.size[0] * TERRAIN.size[1];
    const heights = d.createBuffer({ size: count * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = d.createBuffer({ size: count * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const group = d.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.terrainTexture.view },
        { binding: 1, resource: { buffer: heights } },
      ],
    });
    const enc = d.createCommandEncoder({ label: 'terrain gen' });
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(TERRAIN.size[0] / 8), Math.ceil(TERRAIN.size[1] / 8));
    pass.end();
    // Mark which cells hold water now that the terrain exists.
    const sim = enc.beginComputePass();
    sim.setPipeline(this.simPipelines.initMask);
    sim.setBindGroup(0, this.simUniformGroup);
    sim.setBindGroup(1, this.simGroups[0]);
    sim.dispatchWorkgroups(Math.ceil(SIM.size[0] / 8), Math.ceil(SIM.size[1] / 8));
    sim.end();
    enc.copyBufferToBuffer(heights, 0, read, 0, count * 4);
    d.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    this.heights = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    read.destroy();
    heights.destroy();
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height && this.hdr) return;
    this.width = width;
    this.height = height;
    for (const t of [this.sceneColor, this.sceneDist, this.depth, this.hdr, ...this.bloom]) t?.texture.destroy();
    const d = this.device;
    const T = GPUTextureUsage;
    const make = (label: string, w: number, h: number, format: GPUTextureFormat, usage: number): Target => {
      const texture = d.createTexture({ label, size: [Math.max(1, w), Math.max(1, h)], format, usage });
      return { texture, view: texture.createView() };
    };
    this.sceneColor = make('scene color', width, height, 'rgba16float', T.RENDER_ATTACHMENT | T.TEXTURE_BINDING);
    this.sceneDist = make('scene dist', width, height, 'r32float', T.RENDER_ATTACHMENT | T.TEXTURE_BINDING);
    this.depth = make('depth', width, height, 'depth24plus', T.RENDER_ATTACHMENT);
    this.hdr = make('hdr', width, height, 'rgba16float', T.RENDER_ATTACHMENT | T.TEXTURE_BINDING);
    this.bloom = [];
    let w = width;
    let h = height;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      this.bloom.push(make(`bloom ${i}`, w, h, 'rgba16float', T.RENDER_ATTACHMENT | T.TEXTURE_BINDING));
    }
    this.waterGroup = d.createBindGroup({
      label: 'water',
      layout: this.waterLayout,
      entries: [
        { binding: 0, resource: this.sceneColor.view },
        { binding: 1, resource: this.sceneDist.view },
        { binding: 2, resource: this.shadowMap.view },
        { binding: 3, resource: this.compareSampler },
      ],
    });
    const postGroup = (buffer: GPUBuffer, source: GPUTextureView, bloom: GPUTextureView) =>
      d.createBindGroup({
        layout: this.postLayout,
        entries: [
          { binding: 0, resource: { buffer } },
          { binding: 1, resource: this.linearSampler },
          { binding: 2, resource: source },
          { binding: 3, resource: bloom },
        ],
      });
    this.dummy ??= make('dummy', 1, 1, 'rgba16float', T.TEXTURE_BINDING);
    const dummy = this.dummy.view;
    const down: GPUBindGroup[] = [];
    const up: GPUBindGroup[] = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const source = i === 0 ? this.hdr.view : this.bloom[i - 1].view;
      down.push(postGroup(this.postBuffers[i], source, dummy));
    }
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
      up.push(postGroup(this.postBuffers[BLOOM_LEVELS + i], this.bloom[i + 1].view, dummy));
    }
    this.postGroups = { down, up, composite: postGroup(this.postBuffers[BLOOM_LEVELS * 2], this.hdr.view, this.bloom[0].view) };
  }

  private writePost(time: number, exposure: number) {
    const q = this.device.queue;
    let w = this.width;
    let h = this.height;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      q.writeBuffer(this.postBuffers[i], 0, new Float32Array([0, 0, 0, 0, 1 / w, 1 / h, i === 0 ? 1.4 : 0, time, 1, 1, 0, 0]));
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
    }
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
      const sw = Math.max(1, Math.floor(this.width / 2 ** (i + 2)));
      const sh = Math.max(1, Math.floor(this.height / 2 ** (i + 2)));
      q.writeBuffer(this.postBuffers[BLOOM_LEVELS + i], 0, new Float32Array([0, 0, 0, 0, 1 / sw, 1 / sh, 0, time, 1, 1, 0, 0]));
    }
    q.writeBuffer(
      this.postBuffers[BLOOM_LEVELS * 2],
      0,
      new Float32Array([exposure, 0.06, 0.55, 0.022, 1 / this.width, 1 / this.height, 0, time, 1.06, 1.04, 0, 0]),
    );
  }

  render(sim: SimInput, time: number, exposure: number) {
    const d = this.device;
    d.queue.writeBuffer(this.frameBuffer, 0, this.frameData);
    d.queue.writeBuffer(this.simBuffer, 0, sim.data);
    this.writePost(time, exposure);
    for (const k of this.kinds) k.upload();

    const enc = d.createCommandEncoder({ label: 'frame' });

    // Water.
    if (sim.substeps > 0) {
      const pass = enc.beginComputePass({ label: 'water' });
      const wx = Math.ceil(SIM.size[0] / 8);
      const wy = Math.ceil(SIM.size[1] / 8);
      pass.setBindGroup(0, this.simUniformGroup);
      pass.setPipeline(this.simPipelines.force);
      pass.setBindGroup(1, this.simGroups[this.simCurrent]);
      pass.dispatchWorkgroups(wx, wy);
      pass.setPipeline(this.simPipelines.step);
      for (let i = 0; i < sim.substeps; i++) {
        pass.setBindGroup(1, this.simGroups[this.simCurrent]);
        pass.dispatchWorkgroups(wx, wy);
        this.simCurrent = 1 - this.simCurrent;
      }
      pass.setPipeline(this.simPipelines.surface);
      pass.setBindGroup(1, this.simGroups[this.simCurrent]);
      pass.dispatchWorkgroups(wx, wy);
      pass.end();
    }

    // Caustics.
    {
      const pass = enc.beginRenderPass({
        label: 'caustics',
        colorAttachments: [{ view: this.caustics.view, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setBindGroup(0, this.frameGroup);
      pass.setIndexBuffer(this.causticIndex, 'uint32');
      for (const p of this.causticPipelines) {
        pass.setPipeline(p);
        pass.drawIndexed(this.causticCount);
      }
      pass.end();
    }

    // Sun shadow map.
    {
      const pass = enc.beginRenderPass({
        label: 'shadow',
        colorAttachments: [],
        depthStencilAttachment: { view: this.shadowMap.view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      pass.setBindGroup(0, this.frameGroup);
      pass.setPipeline(this.terrainShadowPipeline);
      pass.setIndexBuffer(this.terrainShadowIndex, 'uint32');
      pass.drawIndexed(this.terrainShadowCount);
      pass.setBindGroup(1, this.emptyGroup);
      for (const k of this.kinds) k.draw(pass, true);
      pass.end();
    }

    // Scene: rock, bed and creatures.
    {
      const pass = enc.beginRenderPass({
        label: 'scene',
        colorAttachments: [
          { view: this.sceneColor.view, clearValue: [0.02, 0.03, 0.04, 1], loadOp: 'clear', storeOp: 'store' },
          { view: this.sceneDist.view, clearValue: [1e4, 0, 0, 1], loadOp: 'clear', storeOp: 'store' },
        ],
        depthStencilAttachment: { view: this.depth.view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      });
      pass.setBindGroup(0, this.frameGroup);
      pass.setBindGroup(1, this.lightingGroup);
      pass.setPipeline(this.terrainPipeline);
      pass.setIndexBuffer(this.terrainIndex, 'uint32');
      pass.drawIndexed(this.terrainCount);
      for (const k of this.kinds) k.draw(pass, false);
      pass.end();
    }

    // Water surface.
    {
      const pass = enc.beginRenderPass({
        label: 'surface',
        colorAttachments: [{ view: this.hdr.view, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(this.waterPipeline);
      pass.setBindGroup(0, this.frameGroup);
      pass.setBindGroup(1, this.waterGroup);
      pass.draw(3);
      pass.end();
    }

    // Bloom and grade.
    const groups = this.postGroups!;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const pass = enc.beginRenderPass({
        label: `bloom down ${i}`,
        colorAttachments: [{ view: this.bloom[i].view, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(this.downPipeline);
      pass.setBindGroup(0, groups.down[i]);
      pass.draw(3);
      pass.end();
    }
    groups.up.forEach((group, n) => {
      const level = BLOOM_LEVELS - 2 - n;
      const pass = enc.beginRenderPass({
        label: `bloom up ${level}`,
        colorAttachments: [{ view: this.bloom[level].view, loadOp: 'load', storeOp: 'store' }],
      });
      pass.setPipeline(this.upPipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    });
    {
      const pass = enc.beginRenderPass({
        label: 'composite',
        colorAttachments: [
          { view: this.context.getCurrentTexture().createView(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' },
        ],
      });
      pass.setPipeline(this.compositePipeline);
      pass.setBindGroup(0, groups.composite);
      pass.draw(3);
      pass.end();
    }
    d.queue.submit([enc.finish()]);
  }
}

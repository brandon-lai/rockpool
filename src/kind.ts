// A kind of creature: one procedural mesh drawn instanced, with per-instance
// data written from the CPU every frame. Each shader exposes `vs`, `fs` and
// `vsShadow` and reads its instances from @group(2) @binding(0).

export interface Layouts {
  frame: GPUBindGroupLayout;
  lighting: GPUBindGroupLayout;
  object: GPUBindGroupLayout;
  empty: GPUBindGroupLayout;
}

export interface MeshData {
  vertices: Float32Array; // vec4f per vertex
  indices: Uint32Array;
}

export class Kind {
  readonly data: Float32Array;
  private readonly instanceBuffer: GPUBuffer;
  private readonly vertexBuffer: GPUBuffer;
  private readonly indexBuffer: GPUBuffer;
  private readonly indexCount: number;
  private readonly scenePipeline: GPURenderPipeline;
  private readonly shadowPipeline: GPURenderPipeline;
  private readonly group: GPUBindGroup;
  count: number;

  constructor(
    private readonly device: GPUDevice,
    label: string,
    code: string,
    mesh: MeshData,
    readonly capacity: number,
    readonly floatsPerInstance: number,
    layouts: Layouts,
  ) {
    this.count = capacity;
    this.data = new Float32Array(Math.max(capacity, 1) * floatsPerInstance);
    this.instanceBuffer = device.createBuffer({
      label: `${label} instances`,
      size: this.data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.vertexBuffer = device.createBuffer({
      label: `${label} vertices`,
      size: mesh.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vertexBuffer, 0, mesh.vertices);
    this.indexBuffer = device.createBuffer({
      label: `${label} indices`,
      size: mesh.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuffer, 0, mesh.indices);
    this.indexCount = mesh.indices.length;

    const module = device.createShaderModule({ label, code });
    const vertexBuffers: GPUVertexBufferLayout[] = [
      { arrayStride: 16, attributes: [{ format: 'float32x4', offset: 0, shaderLocation: 0 }] },
    ];
    this.scenePipeline = device.createRenderPipeline({
      label: `${label} scene`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, layouts.lighting, layouts.object] }),
      vertex: { module, entryPoint: 'vs', buffers: vertexBuffers },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }, { format: 'r32float' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.shadowPipeline = device.createRenderPipeline({
      label: `${label} shadow`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, layouts.empty, layouts.object] }),
      vertex: { module, entryPoint: 'vsShadow', buffers: vertexBuffers },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'less',
        depthBias: 2,
        depthBiasSlopeScale: 2,
      },
    });
    this.group = device.createBindGroup({
      label: `${label} group`,
      layout: layouts.object,
      entries: [{ binding: 0, resource: { buffer: this.instanceBuffer } }],
    });
  }

  upload() {
    this.device.queue.writeBuffer(this.instanceBuffer, 0, this.data, 0, Math.max(this.count, 1) * this.floatsPerInstance);
  }

  draw(pass: GPURenderPassEncoder, shadow: boolean) {
    if (this.count === 0) return;
    pass.setPipeline(shadow ? this.shadowPipeline : this.scenePipeline);
    pass.setBindGroup(2, this.group);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    pass.drawIndexed(this.indexCount, this.count);
  }
}

/** Grid of (part, u, v) vertices with quads between them. */
export function gridPart(
  vertices: number[],
  indices: number[],
  part: number,
  along: number,
  across: number,
  closed = false,
) {
  const base = vertices.length / 4;
  const cols = closed ? across : across + 1;
  for (let i = 0; i <= along; i++) {
    for (let j = 0; j < cols; j++) {
      vertices.push(part, i / along, j / across, 0);
    }
  }
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < across; j++) {
      const a = base + i * cols + j;
      const b = base + i * cols + ((j + 1) % cols);
      const c = a + cols;
      const d = b + cols;
      indices.push(a, c, b, b, c, d);
    }
  }
}

import { buildRobotCloud } from './robotGeometry';

// Sampling the robot takes around a second: keep it off the main thread.
self.onmessage = (event: MessageEvent<{ count: number }>) => {
  const cloud = buildRobotCloud(event.data.count);
  self.postMessage(cloud, { transfer: [cloud.positions.buffer, cloud.normals.buffer, cloud.tones.buffer, cloud.headWeights.buffer] });
};

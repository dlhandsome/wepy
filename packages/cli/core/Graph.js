module.exports = class Graph {
  constructor() {
    this.vertices = [];
    this.adjList = {};
  }
  addVertices(v) {
    if (this.vertices.indexOf(v) > -1) {
      // do nothing
    } else {
      this.vertices.push(v);
      this.adjList[v] = [];
    }
  }
  addEdge(a, b) {
    const edge = this.adjList[a];
    if (!Array.isArray(edge)) {
      this.addVertices(a);
    }
    edge.push(b);
  }
};

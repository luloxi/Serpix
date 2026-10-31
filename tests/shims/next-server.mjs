export class NextResponse extends Response {
  static json(data, init) {
    return Response.json(data, init);
  }
}

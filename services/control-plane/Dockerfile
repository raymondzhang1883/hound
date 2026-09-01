FROM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS build
WORKDIR /src
COPY services/control-plane/go.mod services/control-plane/go.sum ./
RUN go mod download
COPY services/control-plane/ ./
RUN CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/hound-control .

FROM scratch
COPY --from=build /out/hound-control /hound-control
USER 65532:65532
EXPOSE 8090
ENTRYPOINT ["/hound-control"]

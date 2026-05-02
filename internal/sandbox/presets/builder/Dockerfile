# Builds the amikactl binary for the correct Linux architecture.
# This image is used as a build-time dependency of amika/base; the binary is
# copied from it via COPY --from during the base image build.
# CGO_ENABLED=0 produces a fully static binary with no glibc dependency.
FROM golang:1.25
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/amikactl/ ./cmd/amikactl/
RUN CGO_ENABLED=0 go build -o amikactl ./cmd/amikactl

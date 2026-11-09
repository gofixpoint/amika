# The dialer image. Build it from this directory:
#
#   docker build -t amika-dialer .
#
# `fly deploy` in this directory builds it with fly.toml.

FROM rust:1.93-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home dialer
COPY --from=build /src/target/release/amika-dialer /usr/local/bin/amika-dialer
USER dialer
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/amika-dialer"]
CMD ["serve"]

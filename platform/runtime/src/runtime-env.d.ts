// Production supplies this additional comparison value. Staging configs remain
// compatible without it; it must never be passed to Go as process identity.
interface RuntimeEnv {
  FEED_IMAGE_BUILD_ID?: string;
}

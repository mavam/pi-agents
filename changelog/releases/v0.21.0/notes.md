Delegated agents now receive result-tool configuration through Pi’s RPC channel, removing temporary environment-based setup. Extension failures inside child agents now fail workflow nodes immediately, making delegated workflows more reliable.

## 🔧 Changes

### Configure the delegated result tool over RPC

Delegated agents now receive their result-tool configuration over Pi's RPC channel instead of environment variables and a temporary schema file. Extension failures inside the child now fail the workflow node immediately.

*By @mavam.*

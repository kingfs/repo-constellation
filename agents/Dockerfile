ARG AGENT_COMPOSE_GUEST_IMAGE=chaitin/agent-compose-guest:latest
FROM ${AGENT_COMPOSE_GUEST_IMAGE}

USER root
COPY package.json package-lock.json /opt/star-agent/
RUN npm ci --prefix /opt/star-agent --omit=dev && npm cache clean --force

ENV NODE_PATH=/opt/star-agent/node_modules
ENV PLATFORM_API_URL=http://api:8080

COPY scripts/ /opt/star-agent/scripts/

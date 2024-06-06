import { League, LEAGUES, STABLES } from "../../config/leagues";
import { prompt } from "enquirer";
import { Network } from "hardhat/types";

export async function promptLeague(network: Network, message = "Pick a league:"): Promise<League> {
  if (!Object.keys(STABLES).includes(network.name)) {
    throw new Error(
      `Network not supported: ${network.name}. Supported: ${Object.keys(STABLES).join(", ")}.\nRun the command with arg "--network sepolia"\n`,
    );
  }

  const response = (await prompt({
    type: "select",
    name: "leagueId",
    message,
    choices: Object.keys(LEAGUES)
      .reverse()
      .map((id) => ({
        message: `${id} – ${LEAGUES[id](network.name).address ? "deployed" : "not deployed"}`,
        name: id,
        // value: id,
      })),
  })) as { leagueId: string };

  return LEAGUES[response.leagueId](network.name);
}

export function getSaltNonceStart(leagueId: string): number {
  const START = 1000;
  const idx = Object.keys(LEAGUES).findIndex((id) => id === leagueId);
  console.log(Object.keys(LEAGUES).slice(0, idx));
  const saltNonce = Object.keys(LEAGUES)
    .slice(0, idx)
    .reduce((acc, id) => {
      return acc + LEAGUES[id]("base").collectivesAmount;
    }, START);

  console.log("Start salt nonce:", saltNonce);

  return saltNonce;
}

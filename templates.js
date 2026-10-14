// Game templates are starting points and can be edited in the administrator panel.
const t=(key,label,type='text',required=true,extra={})=>({key,label,type,required,...extra});
module.exports={
 'BGMI Squad':[t('team_name','Team Name'),t('p1_name','Player 1 Name (IGL)'),t('p1_uid','Player 1 UID'),t('p2_uid','Player 2 UID'),t('p3_uid','Player 3 UID'),t('p4_uid','Player 4 UID'),t('whatsapp','WhatsApp Number'),t('payment_ss','Payment Screenshot (optional)','file',false)],
 'Free Fire Squad':[t('team_name','Team Name'),t('p1_uid','Player 1 UID (Leader)'),t('p2_uid','Player 2 UID'),t('p3_uid','Player 3 UID'),t('p4_uid','Player 4 UID'),t('whatsapp','WhatsApp Number'),t('payment_ss','Payment Screenshot (optional)','file',false)],
 'Valorant 5v5':[t('team_name','Team Name'),t('captain_riot_id','Captain Riot ID (name#tag)'),t('p2','Player 2 Riot ID'),t('p3','Player 3 Riot ID'),t('p4','Player 4 Riot ID'),t('p5','Player 5 Riot ID'),t('sub','Substitute Riot ID',"text",false),t('whatsapp','WhatsApp Number'),t('payment_ss','Payment Screenshot (optional)','file',false)],
 'Solo (any game)':[t('player_name','Player Name'),t('game_id','In-game ID / UID'),t('whatsapp','WhatsApp Number'),t('payment_ss','Payment Screenshot (optional)','file',false)],
 'Custom (blank)':[t('name','Name'),t('whatsapp','WhatsApp Number')]
};
